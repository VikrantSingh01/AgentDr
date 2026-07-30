import re
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
OVERVIEW = ASSETS / "agentdoctor-overview.png"
ARCHITECTURE = ASSETS / "agentdoctor-architecture.png"

BG = "#F4F7F5"
INK = "#14201B"
MUTED = "#50605A"
WHITE = "#FFFFFF"
NAVY = "#112330"
BLUE = "#246BCE"
BLUE_LIGHT = "#E8F1FF"
GREEN = "#0E6848"
GREEN_LIGHT = "#E5F5ED"
RED = "#A9342F"
RED_LIGHT = "#FBEAE8"
AMBER = "#875000"
AMBER_LIGHT = "#FFF3D8"
BORDER = "#C9D4CE"
GRID = "#DFE6E2"


def load_font(size: int, bold: bool = False, mono: bool = False):
    candidates = []
    if mono and bold:
        candidates += [
            Path("C:/Windows/Fonts/CascadiaMono-Bold.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"),
        ]
    elif mono:
        candidates += [
            Path("C:/Windows/Fonts/CascadiaMono.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
        ]
    elif bold:
        candidates += [
            Path("C:/Windows/Fonts/arialbd.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ]
    candidates += [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


DISPLAY = load_font(52, True)
TITLE = load_font(32, True)
SUBTITLE = load_font(24)
BODY = load_font(20)
BODY_BOLD = load_font(20, True)
SMALL = load_font(18)
SMALL_BOLD = load_font(18, True)
LABEL = load_font(17, True)
MONO = load_font(17, mono=True)
MONO_BOLD = load_font(17, True, True)


def rounded(draw, box, fill=WHITE, outline=BORDER, radius=16, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def write(draw, xy, value, font=BODY, fill=INK, spacing=5, anchor=None):
    draw.multiline_text(
        xy, value, font=font, fill=fill, spacing=spacing, anchor=anchor
    )


def pill(draw, xy, value, fill, color=WHITE):
    x, y = xy
    bounds = draw.textbbox((0, 0), value, font=LABEL)
    width = bounds[2] - bounds[0] + 28
    draw.rounded_rectangle((x, y, x + width, y + 34), radius=17, fill=fill)
    draw.text((x + 14, y + 8), value, font=LABEL, fill=color)
    return x + width


def arrow(draw, start, end, color=BLUE, width=4, dashed=False):
    x1, y1 = start
    x2, y2 = end
    if dashed:
        segments = 10
        for index in range(0, segments, 2):
            start_ratio = index / segments
            end_ratio = min((index + 1) / segments, 0.9)
            draw.line(
                (
                    x1 + (x2 - x1) * start_ratio,
                    y1 + (y2 - y1) * start_ratio,
                    x1 + (x2 - x1) * end_ratio,
                    y1 + (y2 - y1) * end_ratio,
                ),
                fill=color,
                width=width,
            )
    else:
        draw.line((x1, y1, x2, y2), fill=color, width=width)
    angle_x = x2 - x1
    angle_y = y2 - y1
    length = max((angle_x**2 + angle_y**2) ** 0.5, 1)
    ux, uy = angle_x / length, angle_y / length
    px, py = -uy, ux
    size = 13
    draw.polygon(
        [
            (x2, y2),
            (x2 - ux * size + px * 7, y2 - uy * size + py * 7),
            (x2 - ux * size - px * 7, y2 - uy * size - py * 7),
        ],
        fill=color,
    )


def orthogonal_arrow(draw, points, color=BLUE, width=4):
    if len(points) < 2:
        return
    if len(points) > 2:
        draw.line(points[:-1], fill=color, width=width, joint="curve")
    arrow(draw, points[-2], points[-1], color, width)


def dashed_box(draw, box, color, radius=18, width=3):
    x1, y1, x2, y2 = box
    draw.rounded_rectangle(box, radius=radius, outline=color, width=width)
    for x in range(x1 + 20, x2 - 12, 28):
        draw.line((x, y1, min(x + 12, x2), y1), fill=BG, width=width + 2)
        draw.line((x, y2, min(x + 12, x2), y2), fill=BG, width=width + 2)
    for y in range(y1 + 20, y2 - 12, 28):
        draw.line((x1, y, x1, min(y + 12, y2)), fill=BG, width=width + 2)
        draw.line((x2, y, x2, min(y + 12, y2)), fill=BG, width=width + 2)


def count_tests():
    return sum(
        len(re.findall(r"\bit\s*\(", path.read_text(encoding="utf-8")))
        for path in (ROOT / "test").glob("*.test.ts")
    )


def draw_header(draw, width, headline, subhead):
    draw.rectangle((0, 0, width, 14), fill=GREEN)
    write(draw, (64, 44), "AGENT DOCTOR", load_font(22, True), GREEN)
    x = width - 650
    x = pill(draw, (x, 38), "LOCAL-FIRST", NAVY) + 10
    x = pill(draw, (x, 38), "DETERMINISTIC", BLUE) + 10
    pill(draw, (x, 38), "NO MODEL JUDGE", GREEN)
    write(draw, (64, 94), headline, DISPLAY)
    write(draw, (64, 160), subhead, SUBTITLE, MUTED)


def render_overview():
    width, height = 1600, 900
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw_header(
        draw,
        width,
        "Ship agent changes with evidence, not hope.",
        "Test tool workflows locally. Deny configured violations before harness dispatch.",
    )

    boundary = (54, 226, 1546, 720)
    rounded(draw, boundary, WHITE, BLUE, 20, 3)
    write(draw, (78, 242), "AGENT DOCTOR HARNESS", LABEL, BLUE)

    cards = [
        (
            (78, 292, 344, 610),
            "1  DEFINE",
            BLUE,
            "Versioned contract",
            [
                "expected workflow",
                "approved mutations",
                "arguments + outcomes",
                "performance budgets",
                "MCP contract",
            ],
        ),
        (
            (382, 292, 648, 610),
            "2  REQUEST",
            NAVY,
            "Agent asks to act",
            [
                "selected tool",
                "proposed arguments",
                "confirmation evidence",
                "ordered activity",
                "normalized activity",
            ],
        ),
        (
            (686, 292, 952, 610),
            "3  AUTHORIZE",
            AMBER,
            "Optional fail-closed gate",
            [
                "Forbidden?",
                "Confirmed?",
                "Arguments match?",
                "One-use approval?",
                "Policy checked first",
            ],
        ),
    ]
    for box, heading, color, title, lines in cards:
        rounded(draw, box, WHITE, color, 14, 2)
        write(draw, (box[0] + 22, box[1] + 22), heading, LABEL, color)
        write(draw, (box[0] + 22, box[1] + 66), title, BODY_BOLD)
        y = box[1] + 116
        for line in lines:
            draw.ellipse((box[0] + 24, y + 7, box[0] + 32, y + 15), fill=color)
            write(draw, (box[0] + 44, y), line, SMALL, MUTED)
            y += 38

    arrow(draw, (344, 450), (382, 450))
    arrow(draw, (648, 450), (686, 450))

    allow = (1002, 292, 1518, 438)
    deny = (1002, 464, 1518, 610)
    rounded(draw, allow, GREEN_LIGHT, GREEN, 14, 2)
    rounded(draw, deny, RED_LIGHT, RED, 14, 2)
    write(draw, (1026, 313), "AUTHORIZED", LABEL, GREEN)
    write(draw, (1026, 350), "Fixture or MCP dispatch", TITLE, GREEN)
    write(
        draw,
        (1026, 394),
        "requested → authorized → dispatched → completed",
        MONO,
        MUTED,
    )
    write(draw, (1026, 485), "DENIED", LABEL, RED)
    write(draw, (1026, 522), "Backend is not called", TITLE, RED)
    write(draw, (1026, 566), "requested → denied  •  critical exit 3", MONO, MUTED)
    arrow(draw, (952, 396), (1002, 365), GREEN)
    arrow(draw, (952, 492), (1002, 537), RED)

    write(
        draw,
        (78, 646),
        "Every path produces ordered evidence → deterministic findings → local JSON report → stable CI exit code",
        BODY_BOLD,
        NAVY,
    )

    stats = [
        ("ARGUMENT-AWARE REPLAY", "$cases by arguments or call index"),
        ("EXPLICIT LIFECYCLE", "request-to-completion states"),
        (f"{count_tests()} TESTS", "across 13 deterministic test files"),
        ("8 LIVE MCP CASES", "official TypeScript SDK v2"),
    ]
    card_width = 354
    for index, (heading, copy) in enumerate(stats):
        x = 54 + index * 386
        rounded(draw, (x, 752, x + card_width, 846), WHITE, BORDER, 12, 2)
        write(draw, (x + 18, 770), heading, SMALL_BOLD, GREEN if index < 2 else BLUE)
        write(draw, (x + 18, 804), copy, SMALL, MUTED)

    write(
        draw,
        (54, 870),
        "Bounded claim: enforcement applies only to fixture or MCP calls routed through the harness; Agent Doctor is not a sandbox.",
        SMALL,
        AMBER,
    )
    image.save(OVERVIEW, optimize=True)


def node(draw, box, title, subtitle="", fill=WHITE, outline=BORDER, color=INK):
    rounded(draw, box, fill, outline, 12, 2)
    write(draw, ((box[0] + box[2]) // 2, box[1] + 22), title, BODY_BOLD, color, anchor="ma")
    if subtitle:
        wrapped = "\n".join(textwrap.wrap(subtitle, width=30))
        write(
            draw,
            ((box[0] + box[2]) // 2, box[1] + 58),
            wrapped,
            SMALL,
            MUTED,
            anchor="ma",
        )


def render_architecture():
    width, height = 1800, 1100
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw_header(
        draw,
        width,
        "Where Agent Doctor detects and where it prevents.",
        "A layered view of the protocol boundary, backend dispatch, and CI evidence.",
    )

    # Column headers
    columns = [
        (54, 344, "01  CONTRACT + AGENT", "Versioned policy + adapter"),
        (374, 1200, "02  AGENT DOCTOR HARNESS", "Policy-gated mediation"),
        (1230, 1718, "03  TOOL BACKENDS", "Deterministic fixture or real MCP"),
    ]
    for x1, x2, heading, subtitle in columns:
        write(draw, (x1, 236), heading, LABEL, BLUE if x1 != 1230 else GREEN)
        write(draw, (x1, 264), subtitle, SMALL, MUTED)
        draw.line((x1, 294, x2, 294), fill=GRID, width=2)

    # Contract and adapter
    node(
        draw,
        (54, 336, 344, 450),
        "Scenario contract",
        "policy • fixtures/MCP • expectations",
        BLUE_LIGHT,
        BLUE,
    )
    node(
        draw,
        (54, 518, 344, 632),
        "JSONL agent adapter",
        "tool_call • confirmation • final",
        WHITE,
        NAVY,
    )
    arrow(draw, (199, 450), (199, 518), BLUE)
    write(draw, (218, 474), "run_start", MONO, BLUE)

    # Mediation boundary: a single professional processing pipeline.
    mediation = (374, 320, 1200, 660)
    rounded(draw, mediation, "#F8FBFF", BLUE, 18, 3)
    write(draw, (398, 340), "HARNESS MEDIATION BOUNDARY", LABEL, BLUE)
    write(
        draw,
        (398, 368),
        "The enforceable surface: request capture → optional authorization → dispatch.",
        SMALL,
        MUTED,
    )
    node(draw, (412, 430, 634, 548), "Request capture", "record requested lifecycle")
    node(
        draw,
        (678, 430, 922, 548),
        "Dispatch policy",
        "observe, or fail-closed enforcement",
        AMBER_LIGHT,
        AMBER,
    )
    node(
        draw,
        (966, 430, 1162, 548),
        "Backend router",
        "fixture or MCP",
        GREEN_LIGHT,
        GREEN,
    )
    orthogonal_arrow(
        draw,
        [(344, 575), (378, 575), (378, 489), (412, 489)],
        BLUE,
    )
    arrow(draw, (634, 489), (678, 489), BLUE)
    arrow(draw, (922, 489), (966, 489), GREEN)

    denied = (650, 576, 950, 632)
    rounded(draw, denied, RED_LIGHT, RED, 10, 2)
    write(draw, (800, 588), "DENIED: no backend dispatch", SMALL_BOLD, RED, anchor="ma")
    arrow(draw, (800, 548), (800, 576), RED)

    # Backends
    node(
        draw,
        (1230, 374, 1718, 488),
        "Argument-aware fixture replay",
        "$cases by arguments and call index; no silent fallback",
        WHITE,
        GREEN,
    )
    node(
        draw,
        (1230, 534, 1718, 648),
        "MCP stdio server",
        "initialize • tools/list • tools/call via official SDK v2",
        WHITE,
        GREEN,
    )
    orthogonal_arrow(
        draw,
        [(1162, 489), (1196, 489), (1196, 431), (1230, 431)],
        GREEN,
    )
    orthogonal_arrow(
        draw,
        [(1162, 489), (1196, 489), (1196, 591), (1230, 591)],
        GREEN,
    )

    # Out-of-band boundary is intentionally separate from the main architecture.
    out_box = (54, 696, 344, 790)
    rounded(draw, out_box, RED_LIGHT, RED, 10, 2)
    write(draw, (74, 714), "OUTSIDE THE HARNESS", SMALL_BOLD, RED)
    write(draw, (74, 744), "network • filesystem • subprocess\n• native MCP client", SMALL, MUTED)
    arrow(draw, (199, 632), (199, 696), RED, 3, True)

    # A single evidence bus avoids crossing arrows and mixed abstraction.
    bus_y = 724
    draw.line((412, bus_y, 1740, bus_y), fill=GREEN, width=4)
    draw.ellipse((406, bus_y - 6, 418, bus_y + 6), fill=GREEN)
    write(draw, (430, 688), "ORDERED LIFECYCLE + BACKEND EVIDENCE", LABEL, GREEN)
    evidence_sources = [
        (523, 548),
        (800, 632),
        (1064, 548),
        (1550, 648),
    ]
    for x, source_y in evidence_sources:
        draw.line((x, source_y, x, bus_y), fill=GREEN, width=3)
        draw.ellipse((x - 5, bus_y - 5, x + 5, bus_y + 5), fill=GREEN)
    draw.line((1718, 431, 1740, 431, 1740, bus_y), fill=GREEN, width=3)
    draw.ellipse((1735, bus_y - 5, 1745, bus_y + 5), fill=GREEN)

    # Evidence and decision layer
    evidence = (374, 804, 1718, 1000)
    rounded(draw, evidence, NAVY, NAVY, 16, 2)
    write(draw, (398, 824), "04  EVIDENCE + CI DECISION", LABEL, "#8CC9FF")
    evidence_nodes = [
        (412, "Raw evidence", "full or partial trace"),
        (688, "Evaluator", "contracts • MCP • budgets"),
        (964, "Decision", "exit 0 / 1 / 2 / 3"),
        (1240, "Redaction", "before persistence"),
        (1486, "Report", "console + local JSON"),
    ]
    widths = [224, 224, 224, 194, 194]
    for index, ((x, title, subtitle), box_width) in enumerate(
        zip(evidence_nodes, widths)
    ):
        box = (x, 872, x + box_width, 960)
        rounded(draw, box, "#183142", "#365366", 10, 2)
        write(draw, (x + box_width // 2, 890), title, SMALL_BOLD, WHITE, anchor="ma")
        write(draw, (x + box_width // 2, 924), subtitle, SMALL, "#AFC0CA", anchor="ma")
        if index:
            arrow(draw, (x - 52, 916), (x, 916), "#71B4E8", 3)
    arrow(draw, (1064, bus_y), (1064, 804), GREEN)

    write(
        draw,
        (54, 1030),
        "Denied = prevented harness dispatch  •  Finding after dispatch = detected risk  •  Dashed path = outside control",
        BODY_BOLD,
        NAVY,
    )
    write(
        draw,
        (54, 1066),
        "Local/CI host, not a sandbox. Confirmation is adapter-attested; identity, tenant, issuance, and expiry are not authenticated.",
        SMALL,
        AMBER,
    )
    image.save(ARCHITECTURE, optimize=True)


ASSETS.mkdir(parents=True, exist_ok=True)
render_overview()
render_architecture()
print(f"Rendered {OVERVIEW.relative_to(ROOT)} (1600x900)")
print(f"Rendered {ARCHITECTURE.relative_to(ROOT)} (1800x1100)")
