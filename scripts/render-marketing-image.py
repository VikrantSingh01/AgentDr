import json
from pathlib import Path
import textwrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "assets" / "agentdoctor-overview.png"
MEDIA = ROOT / "docs" / "assets" / "safety-failure.media.json"
WIDTH = 1600
HEIGHT = 900

BG = "#F3F6F2"
INK = "#17211D"
MUTED = "#68736E"
BORDER = "#C9D1CC"
WHITE = "#FFFFFF"
TERMINAL = "#131B22"
TERMINAL_MUTED = "#93A5B5"
BLUE = "#246BCE"
GREEN = "#17845E"
AMBER = "#B56A00"
RED = "#C9423A"


def load_font(size: int, bold: bool = False):
    candidates = []
    if bold:
        candidates += [
            Path("C:/Windows/Fonts/arialbd.ttf"),
            Path("C:/Windows/Fonts/CascadiaMono-Bold.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ]
    candidates += [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/CascadiaMono.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


DISPLAY = load_font(54, True)
WORDMARK = load_font(24, True)
BODY = load_font(24)
LABEL = load_font(18, True)
MONO = load_font(18)
MONO_BOLD = load_font(18, True)
MONO_SMALL = load_font(17)
SMALL = load_font(17)


def text(draw, xy, value, font, color=INK, spacing=6):
    draw.multiline_text(xy, value, font=font, fill=color, spacing=spacing)


def panel(draw, box, fill=WHITE):
    draw.rounded_rectangle(box, radius=8, fill=fill, outline=BORDER, width=2)


def pill(draw, xy, value, fill, color=WHITE):
    x, y = xy
    bounds = draw.textbbox((0, 0), value, font=LABEL)
    width = bounds[2] - bounds[0] + 28
    draw.rounded_rectangle((x, y, x + width, y + 34), radius=8, fill=fill)
    draw.text((x + 14, y + 7), value, font=LABEL, fill=color)
    return x + width


def arrow(draw, x1, x2, y):
    draw.line((x1, y, x2 - 12, y), fill=BLUE, width=4)
    draw.polygon([(x2 - 12, y - 8), (x2, y), (x2 - 12, y + 8)], fill=BLUE)


media = json.loads(MEDIA.read_text(encoding="utf-8"))
event = media["event"]
result = media["result"]
finding = media["finding"]
tool_name = media["confirmationRequiredBefore"]
if tool_name != event["tool"] or finding["evidenceSequence"] != event["sequence"]:
    raise ValueError("Safety media metadata does not link the protected tool and finding")

report_path = (ROOT / media["report"].removeprefix("./")).resolve()
if ROOT.resolve() not in report_path.parents:
    raise ValueError("Safety media report must remain inside the repository")
report = json.loads(report_path.read_text(encoding="utf-8"))
report_event = next(
    (item for item in report["evidence"] if item["sequence"] == event["sequence"]),
    None,
)
report_result = next(
    (item for item in report["evidence"] if item["sequence"] == result["sequence"]),
    None,
)
report_finding = next(
    (item for item in report["decision"]["findings"] if item["id"] == finding["id"]),
    None,
)
if report_event is None or any(report_event.get(key) != value for key, value in event.items()):
    raise ValueError("Safety media event does not match its report")
if report_result is None or any(
    report_result.get(key) != value for key, value in result.items()
):
    raise ValueError("Safety media result does not match its report")
if report_finding != finding or report["decision"]["exitCode"] != media["exitCode"]:
    raise ValueError("Safety media decision does not match its report")

severity_label = finding["severity"].upper()
severity_color = RED if finding["severity"] == "critical" else AMBER

flow_lines = [
    f"#{event['sequence']} {event['type']} {event['tool']}",
    f"#{result['sequence']} {result['type']} source={result['source']}",
    f"{severity_label} {finding['id']}",
    *textwrap.wrap(finding["message"], width=52),
    f"Exit code: {media['exitCode']}",
]

image = Image.new("RGB", (WIDTH, HEIGHT), BG)
draw = ImageDraw.Draw(image)

# Header
draw.rectangle((0, 0, WIDTH, 18), fill=GREEN)
text(draw, (72, 54), "AGENT DOCTOR", WORDMARK, GREEN)
pill(draw, (1122, 48), "LOCAL-FIRST", INK)
pill(draw, (1268, 48), "DETERMINISTIC", BLUE)
text(draw, (72, 105), "Test protocol-mediated agent actions.", DISPLAY)
text(
    draw,
    (72, 177),
    "Run a scenario. Capture ordered evidence. Fail CI when a contract is violated.",
    BODY,
    MUTED,
)

# Three-stage product story
left = (72, 255, 440, 650)
middle = (485, 255, 1105, 650)
right = (1150, 255, 1528, 650)
panel(draw, left)
panel(draw, middle, TERMINAL)
panel(draw, right)

# Contract panel
text(draw, (96, 280), "1  DEFINE THE CONTRACT", LABEL, BLUE)
text(draw, (96, 324), "Require confirmation", BODY, INK)
code_lines = [
    "expect:",
    "  confirmation:",
    "    requiredBefore:",
    f"      - {tool_name}",
]
y = 378
for line in code_lines:
    draw.text(
        (92, y),
        line,
        font=MONO_SMALL if tool_name in line else MONO,
        fill=BLUE if tool_name in line else INK,
    )
    y += 31
text(draw, (96, 548), "One matching event must appear", SMALL, MUTED)
text(draw, (96, 575), "before the protected call.", SMALL, MUTED)
pill(draw, (96, 612), "SCENARIO YAML", BLUE)

# Evidence terminal panel
text(draw, (512, 280), "2  OBSERVE THE RECORDED RUN", LABEL, "#7FC5FF")
pill(draw, (884, 276), "REPORT-DERIVED", BLUE)
y = 344
for line in flow_lines:
    color = severity_color if line.startswith(severity_label) else GREEN if "source=fixture" in line else WHITE
    draw.text(
        (516, y),
        line,
        font=MONO_BOLD if line.startswith(severity_label) else MONO,
        fill=color,
    )
    y += 43
draw.line((512, 606, 1076, 606), fill="#344253", width=1)
text(draw, (516, 620), f"Source: {media['report']}", SMALL, TERMINAL_MUTED)

# Decision panel
text(draw, (1176, 280), "3  MAKE A CI DECISION", LABEL, BLUE)
pill(draw, (1176, 326), severity_label, severity_color)
pill(draw, (1362, 326), f"EXIT {media['exitCode']}", INK)
text(draw, (1176, 384), "Finding", BODY, severity_color)
text(draw, (1176, 430), finding["id"], MONO_SMALL, INK)
text(
    draw,
    (1176, 472),
    "\n".join(textwrap.wrap(finding["message"], width=31)),
    SMALL,
    MUTED,
)
draw.line((1176, 556, 1498, 556), fill=BORDER, width=2)
text(draw, (1176, 575), f"Evidence #{event['sequence']}", MONO_BOLD, BLUE)
text(draw, (1176, 608), f"Result source: {result['source']}", SMALL, MUTED)

arrow(draw, 440, 485, 452)
arrow(draw, 1105, 1150, 452)

# Trust boundary rail
rail = (72, 704, 1528, 838)
panel(draw, rail)
columns = [
    (96, "OBSERVED EVENT", f"{event['type']} at evidence #{event['sequence']}\nfor {event['tool']}."),
    (580, "MEDIATED RESULT", f"{result['type']} at evidence #{result['sequence']}\nuses source={result['source']}."),
    (1064, "TEST BOUNDARY", "Detection occurs after observation;\nthis is not a pre-dispatch gate."),
]
for index, (x, heading, copy) in enumerate(columns):
    if index:
        draw.line((x - 28, 724, x - 28, 818), fill=BORDER, width=2)
    text(draw, (x, 729), heading, LABEL, GREEN if index == 0 else BLUE if index == 1 else RED)
    text(draw, (x, 768), copy, SMALL, MUTED)

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUTPUT, optimize=True)
print(f"Rendered {OUTPUT.relative_to(ROOT)} ({WIDTH}x{HEIGHT})")