"""
OM (any document) -> per-page text JSON, for Claude extraction.

Text-only on purpose: OMs run 50-100+ pages and tens of MB (a reference OM is
48MB — over the Claude API's document size cap), but they're InDesign-built
with real text layers, so extracted text preserves everything the model needs
while shrinking the payload ~100x. Page numbers are kept so every extracted
field can carry a source-page reference on the review screen.

Not every OM is a clean PDF, though:
  * the file type is decided from its BYTES, not its name — a PDF saved as
    ".PDF", ".pdf.pdf" or with no extension still reads;
  * images (JPEG/PNG/TIFF/…), XPS, EPUB and other formats MuPDF can open are
    converted to PDF first;
  * pages with no text layer (a scan, a flattened image page) are rendered to
    JPEG and returned in `images`, so the server can send them to Claude as
    pictures instead of silently dropping them.

stdout carries exactly one JSON document. 2026-09-22: current PyMuPDF prints
"warning: The `fitz` API is deprecated…" to STDOUT on import, which put a line
of text in front of the JSON and failed every OM upload with "Unexpected token
w". Everything that might print — the import, MuPDF's own warnings — now goes
to stderr, and only the final JSON is written to the real stdout.

Usage: python om_text.py <file>   -> JSON {pages:[{page,text}], images:[{page,media_type,data}], truncated}
"""
import base64
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr          # anything a library prints goes to stderr

try:
    import pymupdf as fitz       # PyMuPDF >= 1.24
except ImportError:              # older installs only have the fitz name
    import fitz

try:
    fitz.TOOLS.mupdf_display_warnings(False)
    fitz.TOOLS.mupdf_display_errors(False)
except Exception:
    pass

MAX_PAGES = 150
MAX_TOTAL_CHARS = 450_000
# A page with less text than this is treated as having no text layer.
MIN_PAGE_CHARS = 40
# Image fallback budget: enough for a scanned OM's key pages, small enough to
# stay well inside one API request.
MAX_IMAGE_PAGES = 20
MAX_IMAGE_BYTES = 14_000_000
IMAGE_LONG_EDGE_PX = 1568


def emit(obj):
    _REAL_STDOUT.write(json.dumps(obj))
    _REAL_STDOUT.write("\n")
    _REAL_STDOUT.flush()


def sniff(path):
    """Best-guess file type from the first bytes."""
    with open(path, "rb") as f:
        head = f.read(2048)
    if b"%PDF-" in head[:1024]:
        return "pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG"):
        return "png"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "tif"
    if head.startswith(b"GIF8"):
        return "gif"
    if head.startswith(b"BM"):
        return "bmp"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith(b"PK"):
        return "zip"             # docx/pptx/xlsx/xps/epub — MuPDF opens some
    return None


# ── Word / PowerPoint ────────────────────────────────────────────────────────
# The owner, 2026-10-21: "it accepts all forms of it." A broker OM sometimes comes
# as the .docx or .pptx it was built in, and MuPDF cannot open Office files, so
# before today those were refused with "save it as a PDF". The text is read
# straight out of the file's XML instead — no Word, no LibreOffice on Render.
# Text only, by his answer: charts and photos inside the file are not read, and
# the count of them comes back as office_media_skipped so the tab can say so.
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
DOCX_PAGE_CHARS = 3500     # a .docx has no pages; chunk so page refs still mean something


def _docx_pages(z):
    root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(W_NS + "body")
    pages, cur = [], []

    def flush():
        txt = "\n".join(l for l in cur if l.strip())
        if txt:
            pages.append(txt)
        cur.clear()

    def para_text(p):
        out = []
        for el in p.iter():
            if el.tag == W_NS + "t" and el.text:
                out.append(el.text)
            elif el.tag == W_NS + "tab":
                out.append(" ")
            elif el.tag == W_NS + "br" and el.get(W_NS + "type") == "page":
                out.append("\f")
        return "".join(out)

    for block in list(body if body is not None else []):
        if block.tag == W_NS + "p":
            lines = para_text(block).split("\f")
        elif block.tag == W_NS + "tbl":
            lines = [" | ".join(" ".join(para_text(p) for p in tc.iter(W_NS + "p")).strip()
                                for tc in tr.iter(W_NS + "tc"))
                     for tr in block.iter(W_NS + "tr")]
        else:
            continue
        for i, line in enumerate(lines):
            if i > 0:
                flush()          # an explicit page break
            cur.append(" ".join(line.split()))
        if sum(len(l) for l in cur) > DOCX_PAGE_CHARS:
            flush()
    flush()
    return pages


def _pptx_pages(z):
    def num(n):
        m = re.search(r"(\d+)\.xml$", n)
        return int(m.group(1)) if m else 0
    slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=num)
    pages = []
    for n in slides:
        root = ET.fromstring(z.read(n))
        lines = []
        for p in root.iter(A_NS + "p"):
            t = "".join(el.text or "" for el in p.iter(A_NS + "t"))
            if t.strip():
                lines.append(" ".join(t.split()))
        pages.append("\n".join(lines))
    return pages


def office_pages(path):
    """(pages, kind, media_count) for a .docx/.pptx, else None."""
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        return None
    names = set(z.namelist())
    if "word/document.xml" in names:
        pages, kind, media = _docx_pages(z), "docx", "word/media/"
    elif any(n.startswith("ppt/slides/slide") for n in names):
        pages, kind, media = _pptx_pages(z), "pptx", "ppt/media/"
    else:
        return None
    return pages, kind, sum(1 for n in names if n.startswith(media))


def open_as_pdf(path):
    """Open `path` as a PDF document, converting when it is something else."""
    kind = sniff(path)
    if kind == "pdf":
        return fitz.open(path, filetype="pdf"), "pdf"
    if kind == "zip":
        # MuPDF reads XPS/EPUB/CBZ out of a zip; Office files it cannot.
        for ft in ("xps", "epub", "cbz"):
            try:
                src = fitz.open(path, filetype=ft)
                if src.page_count:
                    return fitz.open("pdf", src.convert_to_pdf()), ft
            except Exception:
                continue
        raise ValueError(
            "This looks like an Excel workbook, not a document. "
            "Spreadsheets are read as rent rolls / T12s, not as an OM.")
    try:
        src = fitz.open(path, filetype=kind) if kind else fitz.open(path)
    except Exception:
        raise ValueError("Could not open this file as a PDF or image. "
                         "Save the OM as a PDF and upload that.")
    if src.is_pdf:
        return src, "pdf"
    return fitz.open("pdf", src.convert_to_pdf()), kind or "document"


def render_jpeg(page):
    rect = page.rect
    long_edge = max(rect.width, rect.height) or 1
    zoom = min(3.0, IMAGE_LONG_EDGE_PX / long_edge)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    try:
        return pix.tobytes("jpeg", jpg_quality=70)
    except TypeError:            # older PyMuPDF: no quality argument
        return pix.tobytes("jpeg")


def main(path):
    if sniff(path) == "zip":
        office = office_pages(path)
        if office:
            texts, kind, media = office
            pages, total, truncated = [], 0, False
            for i, text in enumerate(texts[:MAX_PAGES], start=1):
                if total + len(text) > MAX_TOTAL_CHARS:
                    text = text[: MAX_TOTAL_CHARS - total]
                    truncated = True
                pages.append({"page": i, "text": text})
                total += len(text)
                if truncated:
                    break
            emit({"pages": pages, "images": [], "image_pages_skipped": 0,
                  "office_media_skipped": media, "source_kind": kind,
                  "page_count": len(texts), "chars": total,
                  "truncated": truncated or len(texts) > MAX_PAGES})
            return
    try:
        doc, source_kind = open_as_pdf(path)
    except ValueError as e:
        emit({"error": str(e)})
        return
    pages, images = [], []
    total, image_bytes = 0, 0
    truncated = False
    image_pages_skipped = 0
    for i, page in enumerate(doc, start=1):
        if i > MAX_PAGES:
            truncated = True
            break
        try:
            text = (page.get_text() or "").strip()
        except Exception:
            text = ""
        text = "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip())
        if len(text) < MIN_PAGE_CHARS:
            if len(images) < MAX_IMAGE_PAGES and image_bytes < MAX_IMAGE_BYTES:
                try:
                    jpg = render_jpeg(page)
                    images.append({"page": i, "media_type": "image/jpeg",
                                   "data": base64.b64encode(jpg).decode("ascii")})
                    image_bytes += len(jpg)
                except Exception:
                    image_pages_skipped += 1
            else:
                image_pages_skipped += 1
        if total + len(text) > MAX_TOTAL_CHARS:
            text = text[: MAX_TOTAL_CHARS - total]
            truncated = True
        pages.append({"page": i, "text": text})
        total += len(text)
        if truncated:
            break
    emit({
        "pages": pages,
        "images": images,
        "image_pages_skipped": image_pages_skipped,
        "source_kind": source_kind,
        "page_count": doc.page_count,
        "chars": total,
        "truncated": truncated,
    })


if __name__ == "__main__":
    if len(sys.argv) != 2:
        emit({"error": "Usage: python om_text.py <file>"})
        sys.exit(1)
    try:
        main(sys.argv[1])
    except Exception as e:
        emit({"error": f"Could not read the OM: {e}"})
