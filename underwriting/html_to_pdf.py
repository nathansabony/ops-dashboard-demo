"""
Print-ready HTML -> PDF, using only PyMuPDF (already installed for the OM reader).

The owner, 2026-10-22: a PDF report beside every deal's Excel model. PyMuPDF ships a
small HTML/CSS layout engine (Story), so the report is a real PDF file written on
the server - no browser, no new package on Render. The engine reads plain HTML
tables and a modest CSS subset (no flex or grid), so the report is built from
tables. A page footer is stamped afterwards ("Page n of N").

    python html_to_pdf.py <in.html> <out.pdf> "<footer text>" "<title>"

Emits JSON {"pages": N, "bytes": N} or {"error": "..."}.
"""
import json
import sys

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

try:
    import pymupdf as fitz
except ImportError:
    import fitz

try:
    fitz.TOOLS.mupdf_display_warnings(False)
    fitz.TOOLS.mupdf_display_errors(False)
except Exception:
    pass

# Forest Ledger: ink #14342A, muted #6B645A, border #E6E1D6, green #14532D, red #8C2020
CSS = """
body { font-family: sans-serif; font-size: 8.5pt; color: #14342A; }
h1 { font-size: 20pt; color: #14342A; margin: 0; }
h2 { font-size: 10.5pt; color: #14532D; margin: 7pt 0 2pt 0; border-bottom: 1px solid #14532D; }
h3 { font-size: 8.5pt; color: #14342A; margin: 6pt 0 2pt 0; }
p { margin: 1.5pt 0; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 7.5pt; color: #6B645A; font-weight: bold; padding: 1.5pt 4pt; border-bottom: 1px solid #C2B9A4; }
td { padding: 1.1pt 4pt; border-bottom: 1px solid #E6E1D6; vertical-align: top; }
.r { text-align: right; }
.muted { color: #6B645A; }
.src { color: #6B645A; font-size: 7pt; }
.good { color: #14532D; font-weight: bold; }
.bad { color: #8C2020; font-weight: bold; }
.amber { color: #7A4E0E; }
.big { font-size: 17pt; font-weight: bold; color: #14342A; }
.lbl { font-size: 7pt; color: #6B645A; font-weight: bold; }
.tile { border: 1px solid #E6E1D6; padding: 5pt 7pt; background-color: #FFFDFA; }
/* the header's tint is drawn onto page 1 afterwards: a background on this cell is repeated as a dark bar
   at the top of every later page by the layout engine */
.band { color: #14342A; padding: 8pt 10pt; border-left: 4px solid #14532D; }
.band h1 { color: #14342A; }
.band p { color: #6B645A; }
.review { border-left: 4px solid #8C2020; background-color: #F7EDEC; padding: 4pt 8pt; color: #8C2020; }
.note { border-left: 3px solid #B98A2E; background-color: #F7F1E3; padding: 4pt 7pt; margin: 4pt 0; }
.tot td { font-weight: bold; border-top: 1px solid #14342A; }
"""


MAX_PAGES = 3
# Tighter type for a report that would otherwise spill onto a fourth page (a deal with a long review box and many notes).
# Tried in order; the first that fits three pages wins, and the least-tight layout that does not fit is never shipped over a tighter one.
COMPACT_STEPS = [
    "body { font-size: 8pt; } td { padding: 0.7pt 4pt; } h2 { margin: 5pt 0 1pt 0; } p { margin: 1pt 0; }",
    "body { font-size: 7.6pt; } td { padding: 0.4pt 3.5pt; } h2 { margin: 4pt 0 1pt 0; } h3 { margin: 4pt 0 1pt 0; } p { margin: 0.6pt 0; } .tile { padding: 3pt 6pt; }",
]


def lay_out(html, css, scratch, mediabox, where):
    story = fitz.Story(html=html, user_css=css)
    writer = fitz.DocumentWriter(scratch)
    more, guard = 1, 0
    while more and guard < 60:
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
        guard += 1
    writer.close()
    del writer, story


def main(src, out, footer, title):
    html = open(src, encoding="utf-8").read()
    mediabox = fitz.paper_rect("letter")
    where = mediabox + (36, 30, -36, -46)      # a little wider and taller than before: the full report must fit three pages
    # lay the story out into a scratch file, then stamp footers into the real output: replacing a
    # file PyMuPDF has just closed fails on Windows ("Access is denied"), so the two never share a name
    import os
    scratch = out + ".story"
    compact = 0
    lay_out(html, CSS, scratch, mediabox, where)
    for step in COMPACT_STEPS:
        d = fitz.open(scratch)
        pages = d.page_count
        d.close()
        if pages <= MAX_PAGES:
            break
        compact += 1
        lay_out(html, CSS + "\n" + step, scratch, mediabox, where)
    doc = fitz.open(scratch)
    n = doc.page_count
    first = doc[0]
    hit = first.search_for("Underwriting summary")
    if hit:
        first.draw_rect(fitz.Rect(36, 28, first.rect.width - 36, max(h.y1 for h in hit) + 9), color=None, fill=(0.929, 0.953, 0.933), overlay=False)
    for i, page in enumerate(doc, start=1):
        r = page.rect
        page.draw_line((36, r.height - 40), (r.width - 36, r.height - 40), color=(0.9, 0.88, 0.84), width=0.6)
        page.insert_text((36, r.height - 28), footer, fontsize=7, fontname="helv", color=(0.42, 0.39, 0.35))
        label = f"Page {i} of {n}"
        page.insert_text((r.width - 36 - fitz.get_text_length(label, "helv", 7), r.height - 28), label, fontsize=7, fontname="helv", color=(0.42, 0.39, 0.35))
    doc.set_metadata({"title": title, "author": "Cedar Ridge Capital (demo)", "subject": "Underwriting summary", "producer": "Cedar Ridge demo site"})
    doc.save(out, garbage=3, deflate=True)
    doc.close()
    del doc, first
    import gc
    gc.collect()
    try:
        os.remove(scratch)
    except OSError:
        pass   # the caller sweeps <out>.story too (services/underwritingReport.js)
    _REAL_STDOUT.write(json.dumps({"pages": n, "bytes": os.path.getsize(out), "compact": compact}) + "\n")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        _REAL_STDOUT.write(json.dumps({"error": "Usage: python html_to_pdf.py <in.html> <out.pdf> [footer] [title]"}) + "\n")
        sys.exit(1)
    try:
        main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "", sys.argv[4] if len(sys.argv) > 4 else "Underwriting report")
    except Exception as e:
        _REAL_STDOUT.write(json.dumps({"error": f"Could not build the PDF: {e}"}) + "\n")
