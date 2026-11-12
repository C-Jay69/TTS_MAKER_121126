"""Create test fixtures for parser verification: .txt, .md, .pdf, .docx, .doc."""
import os

OUT = "/home/z/my-project/scripts/fixtures"
os.makedirs(OUT, exist_ok=True)

TEXT = (
    "The Whispering Valley\n\n"
    "It was a bright cold day in April, and the clocks were striking thirteen. "
    "Winston walked quickly through the narrow streets, past the old bakery that still "
    "smelled of warm bread despite the early hour.\n\n"
    "He carried a leather satchel over one shoulder. Inside it lay a folded map, a brass "
    "compass, and a letter he had read so many times that the creases had begun to tear.\n\n"
    "The valley, the letter said, remembers every voice that passes through it. "
    "Travelers speak of echoes that answer questions no one asked aloud."
)

# 1. Plain text
with open(f"{OUT}/sample.txt", "w", encoding="utf-8") as f:
    f.write(TEXT)

# 2. Markdown
MD = (
    "# The Whispering Valley\n\n"
    "It was a **bright cold day** in April, and the clocks were striking *thirteen*. "
    "Winston walked quickly through the narrow streets, past the [old bakery](https://example.com/bakery) "
    "that still smelled of warm bread.\n\n"
    "## Chapter One\n\n"
    "- He carried a leather satchel\n"
    "- Inside it lay a folded map\n"
    "- And a letter read many times\n\n"
    "```python\nprint('this code block should vanish')\n```\n\n"
    "The valley, the letter said, > remembers every voice.\n\n"
    "| Item | Count |\n|------|-------|\n| Maps | 2 |\n| Compass | 1 |"
)
with open(f"{OUT}/sample.md", "w", encoding="utf-8") as f:
    f.write(MD)

# 3. PDF (multi-page)
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

pdf_path = f"{OUT}/sample.pdf"
c = canvas.Canvas(pdf_path, pagesize=A4)
paragraphs = [
    "Page one begins the tale of the whispering valley, where every sound is returned to its speaker a moment too late.",
    "The cartographer drew the ridgeline with a steady hand, though her thoughts drifted to the letter waiting at home.",
    "",
]
w, h = A4
c.setFont("Helvetica", 11)
y = h - 80
for para in paragraphs:
    if not para:
        c.showPage()
        c.setFont("Helvetica", 11)
        y = h - 80
        continue
    c.drawString(72, y, para)
    y -= 20
c.drawString(72, y, "Page two carries the rest of the story into the foothills.")
c.showPage()
c.save()

# 4. DOCX
import docx as docxlib

d = docxlib.Document()
d.add_heading("The Whispering Valley", level=1)
d.add_paragraph("It was a bright cold day in April, and the clocks were striking thirteen.")
d.add_paragraph("He carried a leather satchel over one shoulder, and inside it a folded map.")
d.add_paragraph("The valley remembers every voice that passes through it.")
d.save(f"{OUT}/sample.docx")

# 5. Legacy .doc — simulate an OLE2-ish binary: junk bytes + UTF-16LE text + junk
text = "Legacy document text survives the binary container. " * 6
utf16_payload = text.encode("utf-16-le")
junk = bytes(range(256)) * 3
header = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # OLE2 magic
with open(f"{OUT}/sample.doc", "wb") as f:
    f.write(header + junk[:4000] + utf16_payload + junk[:4000] + b"ASCII fallback text runs here too." + junk[:2000])

print("fixtures written:", os.listdir(OUT))
