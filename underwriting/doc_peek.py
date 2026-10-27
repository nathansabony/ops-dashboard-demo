"""
Cheap first look at a dropped document: is it a T12, a rent roll, or an OM?

The owner, 2026-10-21: one drop zone for "T12, OM, and rent roll ... in any form".
Spreadsheets are classified by sheet_pick.py (tab names + content). PDFs, Word,
PowerPoint and photos have no tabs, so this reads the first pages' text and
scores it. No model is called: this is a zero-token guess that the tab shows
with its confidence and lets the person change - it never silently decides.

    python doc_peek.py <file>

Emits JSON:
  {"kind":"rent_roll"|"t12"|"om"|"unknown", "confidence":0..1, "reason":"...",
   "pages":N, "scanned":true|false, "source_kind":"pdf"|"docx"|"pptx"|"jpg"|...}

confidence is how far the winning score sits above the runner-up, not a
probability. Under 0.5, or a scan with no text layer, the tab asks the person.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

PEEK_PAGES = 4

MONTHS = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-'/]*(\d{2}|\d{4})\b", re.I)

SIGNALS = {
    "rent_roll": [
        (r"rent\s*roll", 5), (r"\bunit\s*(#|no|number|type)\b", 2), (r"\b(resident|tenant|lessee)\b", 2),
        (r"lease\s*(start|end|expir|from|to)|move[\s\-]*in", 2), (r"market\s*rent", 2),
        (r"\bsq\.?\s*ft\b|\bsf\b", 1), (r"\bvacant\b", 1), (r"\bbalance\b", 1),
    ],
    "t12": [
        (r"\bt[\s\-]*12\b|trailing\s*(12|twelve)|\bttm\b", 5), (r"income\s*statement|profit\s*(and|&)\s*loss|\bp\s*&\s*l\b", 4),
        (r"net\s*operating\s*income|\bnoi\b", 3), (r"total\s*(operating\s*)?expenses?", 2),
        (r"gross\s*potential|scheduled\s*rent", 2), (r"repairs?\s*(and|&)\s*maint", 2),
        (r"real\s*estate\s*tax|property\s*tax", 1), (r"management\s*fee", 1),
    ],
    "om": [
        (r"offering\s*memorandum|confidential\s*(offering|memorandum)", 6), (r"executive\s*summary", 3),
        (r"investment\s*(highlights|overview|summary)", 3), (r"property\s*(overview|description|highlights)", 2),
        (r"market\s*(overview|analysis)|submarket", 2), (r"\bcomparables?\b|rent\s*comps?|sales?\s*comps?", 2),
        (r"value[\s\-]*add|\bproforma\b|pro\s*forma", 1), (r"\bbroker|exclusive(ly)?\s*(listed|offered)", 2),
    ],
}


def score(text):
    out = {}
    low = text.lower()
    for kind, sigs in SIGNALS.items():
        out[kind] = sum(w for rx, w in sigs if re.search(rx, low))
    # twelve month columns across a statement is the T12's shape no matter what the title says
    months = {m.group(1).lower()[:3] for m in MONTHS.finditer(text)}
    if len(months) >= 8:
        out["t12"] += 4
    # a table of repeated numeric unit rows is a rent roll's shape
    unit_rows = len(re.findall(r"^\s*[A-Za-z]?\d{1,4}[A-Za-z]?\s+\S+.*\$?\s*\d{3,5}(\.\d\d)?\s*$", text, re.M))
    if unit_rows >= 15:
        out["rent_roll"] += 3
    return out


def main(path):
    import om_text
    fitz = om_text.fitz
    kind_hint = om_text.sniff(path)
    texts, source_kind, pages, scanned = [], kind_hint or "document", 0, False
    if kind_hint == "zip":
        office = om_text.office_pages(path)
        if office:
            all_pages, source_kind, _ = office
            pages = len(all_pages)
            texts = all_pages[:PEEK_PAGES]
    if not texts:
        doc, source_kind = om_text.open_as_pdf(path)
        pages = doc.page_count
        # The first pages of an OM are often a cover and full-bleed photos with no text at all (the Estates at
        # Fairway Green OM, 2026-10-22: 3 of 33 pages bare, read as "a scan"). So look at the first few pages
        # AND a few spread through the rest; only a document with no text anywhere in the sample is a scan.
        rest = list(range(PEEK_PAGES, pages))
        spread = [rest[int(k * (len(rest) - 1) / 3)] for k in range(4)] if len(rest) >= 4 else rest
        sample = list(range(min(PEEK_PAGES, pages))) + spread
        for i in sample:
            texts.append((doc[i].get_text() or "").strip())
        # a scan has (almost) no text on any page; an OM with a few bare photo pages has text on most
        scanned = sum(1 for t in texts if len(t) >= 60) < max(1, len(texts) // 4)
    text = "\n".join(texts)
    if scanned:
        res = {"kind": "unknown", "confidence": 0, "reason": "No text layer (a scan or photo) - cannot tell what it is without reading it."}
    else:
        sc = score(text)
        ranked = sorted(sc.items(), key=lambda kv: kv[1], reverse=True)
        (best, bs), (_, second) = ranked[0], ranked[1]
        # a long document with an OM headline is an OM even when it quotes a rent roll or T12 inside
        if pages >= 12 and sc["om"] >= 3 and best != "om":
            best, bs, second = "om", sc["om"] + 3, max(sc["rent_roll"], sc["t12"])
        if bs < 3:
            res = {"kind": "unknown", "confidence": 0, "reason": "Nothing in the first pages says what this is."}
        else:
            conf = round(min(1.0, (bs - second) / max(bs, 1) + (0.15 if bs >= 8 else 0)), 2)
            # A long document whose best match is "OM" is an OM: it quotes rent rolls and T12s all the way through
            # (Pinecrest Village's 17-page OM scored 11 against 10 and was left at 24%, asking what it was).
            if best == "om" and pages >= 12:
                conf = max(conf, 0.6)
            res = {"kind": best, "confidence": conf,
                   "reason": f"{len(texts)} sampled page(s) read as {best.replace('_', ' ')} (score {bs} vs {second})."}
    res.update({"pages": pages, "scanned": scanned, "source_kind": source_kind})
    _REAL_STDOUT.write(json.dumps(res) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        _REAL_STDOUT.write(json.dumps({"error": "Usage: python doc_peek.py <file>"}) + "\n")
        sys.exit(1)
    try:
        main(sys.argv[1])
    except Exception as e:
        _REAL_STDOUT.write(json.dumps({"error": f"Could not read this file: {e}"}) + "\n")
