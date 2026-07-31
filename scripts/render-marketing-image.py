from io import BytesIO
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


def text_width(draw, value, font):
    bounds = draw.textbbox((0, 0), value, font=font)
    return bounds[2] - bounds[0]


def wrap_to_width(draw, value, font, max_width):
    lines = []
    for raw_line in value.splitlines() or [""]:
        words = raw_line.split()
        if not words:
            lines.append("")
            continue
        line = words[0]
        for word in words[1:]:
            candidate = f"{line} {word}"
            if text_width(draw, candidate, font) <= max_width:
                line = candidate
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return "\n".join(lines)


def save_png_if_changed(image, path):
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    content = buffer.getvalue()
    if path.exists() and path.read_bytes() == content:
        return False
    path.write_bytes(content)
    return True


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


def draw_header(draw, width, headline, subhead, pills_config=None):
    if pills_config is None:
        pills_config = [
            ("LOCAL-FIRST", NAVY, WHITE),
            ("DETERMINISTIC", BLUE, WHITE),
            ("NO MODEL JUDGE", GREEN, WHITE),
        ]
    draw.rectangle((0, 0, width, 14), fill=GREEN)
    write(draw, (64, 44), "AGENT DOCTOR", load_font(22, True), GREEN)
    total = 10 * (len(pills_config) - 1)
    for text, _, _ in pills_config:
        bounds = draw.textbbox((0, 0), text, font=LABEL)
        total += bounds[2] - bounds[0] + 28
    x = width - 64 - total
    for index, (text, fill, color) in enumerate(pills_config):
        x = pill(draw, (x, 38), text, fill, color)
        if index != len(pills_config) - 1:
            x += 10
    write(draw, (64, 94), headline, DISPLAY)
    write(draw, (64, 160), subhead, SUBTITLE, MUTED)


def bullet_list(draw, x, y, lines, color=BLUE, text_color=MUTED, font=SMALL, gap=32):
    for line in lines:
        draw.ellipse((x, y + 8, x + 8, y + 16), fill=color)
        write(draw, (x + 20, y), line, font, text_color)
        y += gap
    return y


def metric_card(draw, box, eyebrow, title, body, accent=BLUE, title_font=BODY_BOLD):
    rounded(draw, box, WHITE, accent, 14, 2)
    x, y = box[0] + 20, box[1] + 18
    write(draw, (x, y), eyebrow, LABEL, accent)
    write(draw, (x, y + 38), title, title_font, INK)
    write(draw, (x, y + 84), body, SMALL, MUTED)


def render_overview():
    width, height = 1600, 900
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw_header(
        draw,
        width,
        "Agent actions become reproducible CI evidence.",
        "A local deterministic core scores contracts by replaying behaviour, not by asking a model.",
    )

    boundary = (54, 226, 1546, 598)
    rounded(draw, boundary, WHITE, BLUE, 20, 3)
    write(draw, (78, 242), "AGENT DOCTOR HARNESS", LABEL, BLUE)
    write(
        draw,
        (78, 274),
        "Every harness-mediated tool request is captured as ordered evidence and evaluated into a CI exit code you can inspect.",
        BODY,
        MUTED,
    )

    cards = [
        (
            (78, 330, 388, 548),
            "1  AGENT ACTS",
            BLUE,
            "Tool workflow runs",
            [
                "tool request",
                "confirmation",
                "backend result",
                "final output",
            ],
        ),
        (
            (438, 330, 748, 548),
            "2  EVIDENCE",
            GREEN,
            "Recorded locally",
            [
                "append-only JSON",
                "sequenced lifecycle",
                "redacted before disk",
                "replayable report",
            ],
        ),
        (
            (798, 330, 1108, 548),
            "3  DECIDE",
            NAVY,
            "Deterministic core",
            [
                "structural assertions",
                "no model judge",
                "milliseconds, not minutes",
                "no per-run model cost",
            ],
        ),
        (
            (1158, 330, 1518, 548),
            "4  CI OUTPUT",
            AMBER,
            "Exit code + evidence file",
            [
                "exit 0 / 1 / 2 / 3",
                "console findings",
                "local JSON trace",
                "readable failure path",
            ],
        ),
    ]
    for box, heading, color, title, lines in cards:
        rounded(draw, box, WHITE, color, 14, 2)
        write(draw, (box[0] + 22, box[1] + 22), heading, LABEL, color)
        write(draw, (box[0] + 22, box[1] + 66), title, BODY_BOLD)
        bullet_list(draw, box[0] + 24, box[1] + 112, lines, color, MUTED, SMALL, 28)

    arrow(draw, (388, 439), (438, 439))
    arrow(draw, (748, 439), (798, 439))
    arrow(draw, (1108, 439), (1158, 439))

    write(
        draw,
        (78, 566),
        "Local-first boundary: no trace leaves the machine; fixtures and MCP calls are mediated by the harness, not a sandbox.",
        BODY_BOLD,
        NAVY,
    )

    metric_card(
        draw,
        (54, 632, 414, 812),
        "LOCAL-FIRST",
        "No trace leaves the host",
        "No per-run model call.\nDeterministic checks run in milliseconds,\nnot minutes.",
        GREEN,
    )
    metric_card(
        draw,
        (434, 632, 794, 812),
        "ADVERSARIAL MEASUREMENT",
        "96.7% mutation score",
        "29 killed. The one survivor is\nfree-text prose. 4 invalid + 4\nbehaviour-preserving excluded.",
        BLUE,
        TITLE,
    )
    metric_card(
        draw,
        (814, 632, 1174, 812),
        "WHY ONE SURVIVED",
        "Free-text prose payload",
        "Every structural defect class is\ncaught deterministically. The one\nsurviving mutant is free-text prose.",
        AMBER,
    )
    metric_card(
        draw,
        (1194, 632, 1546, 812),
        "ACKNOWLEDGED WEAKNESS",
        "Precision is still open",
        "8 of 11 correct-behaviour worlds\nstill wrongly blocked (72.7%).\nThis is the open problem.",
        RED,
    )

    write(
        draw,
        (54, 870),
        "Hybrid note: the planned local SLM sidecar is advisory only; the deterministic core remains the CI authority.",
        SMALL,
        AMBER,
    )
    return save_png_if_changed(image, OVERVIEW)


def node(draw, box, title, subtitle="", fill=WHITE, outline=BORDER, color=INK):
    rounded(draw, box, fill, outline, 12, 2)
    write(draw, ((box[0] + box[2]) // 2, box[1] + 22), title, BODY_BOLD, color, anchor="ma")
    if subtitle:
        wrapped = wrap_to_width(draw, subtitle, SMALL, box[2] - box[0] - 32)
        write(
            draw,
            ((box[0] + box[2]) // 2, box[1] + 58),
            wrapped,
            SMALL,
            MUTED,
            anchor="ma",
        )


def dashed_panel(draw, box, fill, outline, radius=18, width=3):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)
    x1, y1, x2, y2 = box
    for x in range(x1 + 20, x2 - 12, 28):
        draw.line((x, y1, min(x + 12, x2), y1), fill=fill, width=width + 2)
        draw.line((x, y2, min(x + 12, x2), y2), fill=fill, width=width + 2)
    for y in range(y1 + 20, y2 - 12, 28):
        draw.line((x1, y, x1, min(y + 12, y2)), fill=fill, width=width + 2)
        draw.line((x2, y, x2, min(y + 12, y2)), fill=fill, width=width + 2)


def intersects(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def contains(a, b):
    return a[0] <= b[0] and a[1] <= b[1] and a[2] >= b[2] and a[3] >= b[3]


def text_bounds(draw, xy, value, font, spacing=5, anchor=None):
    return draw.multiline_textbbox(xy, value, font=font, spacing=spacing, anchor=anchor)


def assert_architecture_layout(draw):
    boxes = [
        ("harness", (318, 312, 1296, 748), None),
        ("agent", (54, 374, 292, 512), None),
        ("adapter", (346, 400, 612, 554), "harness"),
        ("adapter-stdio", (368, 462, 590, 506), "adapter"),
        ("adapter-mcp", (368, 518, 590, 542), "adapter"),
        ("recorder", (652, 394, 880, 548), "harness"),
        ("evaluator", (898, 342, 1268, 704), "harness"),
        ("verdict", (1332, 386, 1718, 548), None),
        ("policy", (346, 610, 612, 720), "harness"),
        ("backends", (652, 592, 850, 730), "harness"),
        ("backend-fixtures", (674, 646, 828, 676), "backends"),
        ("backend-mcp", (674, 688, 828, 718), "backends"),
        ("denied", (326, 766, 632, 820), None),
        ("outside", (54, 594, 292, 720), None),
        ("sidecar", (888, 770, 1310, 990), None),
        ("observe-enforcement", (54, 884, 850, 1020), None),
    ]
    by_name = {name: {"rect": rect, "parent": parent} for name, rect, parent in boxes}

    def is_ancestor(ancestor, child):
        parent = by_name.get(child, {}).get("parent")
        while parent:
            if parent == ancestor:
                return True
            parent = by_name.get(parent, {}).get("parent")
        return False

    def skip_text_box(text_parent, box_name):
        return text_parent == box_name or is_ancestor(box_name, text_parent)

    violations = []
    for index, (left_name, left_rect, _) in enumerate(boxes):
        for right_name, right_rect, _ in boxes[index + 1 :]:
            if intersects(left_rect, right_rect) and not (
                contains(left_rect, right_rect) or contains(right_rect, left_rect)
            ):
                violations.append(f"box intersection: {left_name} x {right_name}")

    def wrapped_for(box_name, value):
        rect = by_name[box_name]["rect"]
        return wrap_to_width(draw, value, SMALL, rect[2] - rect[0] - 32)

    text_runs = [
        ("harness-title", "AGENT DOCTOR HARNESS BOUNDARY", LABEL, (342, 332), "harness", None),
        (
            "harness-subtitle",
            "Fixture/MCP backends are controlled only through this boundary.",
            SMALL,
            (342, 360),
            "harness",
            None,
        ),
        ("agent-title", "Agent under test", BODY_BOLD, (173, 396), "agent", "ma"),
        (
            "agent-subtitle",
            wrapped_for("agent", "unmodified; emits tool requests and final output"),
            SMALL,
            (173, 432),
            "agent",
            "ma",
        ),
        ("adapter-title", "Adapter / transport", BODY_BOLD, (479, 422), "adapter", "ma"),
        ("adapter-stdio-text", "stdio JSONL", SMALL_BOLD, (479, 473), "adapter-stdio", "ma"),
        ("adapter-mcp-text", "real MCP stdio server", SMALL_BOLD, (479, 521), "adapter-mcp", "ma"),
        ("recorder-title", "Evidence recorder", BODY_BOLD, (766, 416), "recorder", "ma"),
        (
            "recorder-subtitle",
            wrapped_for("recorder", "append-only • sequenced • redacted"),
            SMALL,
            (766, 452),
            "recorder",
            "ma",
        ),
        ("evaluator-title", "Deterministic evaluator", BODY_BOLD, (1083, 364), "evaluator", "ma"),
        ("evaluator-authoritative", "AUTHORITATIVE", LABEL, (1083, 398), "evaluator", "ma"),
        (
            "evaluator-authority",
            "Only this layer decides the exit code.",
            SMALL_BOLD,
            (1083, 426),
            "evaluator",
            "ma",
        ),
        ("verdict-title", "Verdict + evidence file", BODY_BOLD, (1525, 408), "verdict", "ma"),
        (
            "verdict-subtitle",
            wrapped_for("verdict", "exit code plus replayable local JSON report"),
            SMALL,
            (1525, 444),
            "verdict",
            "ma",
        ),
        ("verdict-exit", "exit 0 / 1 / 2 / 3", MONO_BOLD, (1525, 500), "verdict", "ma"),
        ("policy-title", "Dispatch policy", BODY_BOLD, (479, 628), "policy", "ma"),
        (
            "policy-subtitle",
            "observe = record only\nenforcement = fail closed",
            SMALL,
            (479, 664),
            "policy",
            "ma",
        ),
        ("backends-title", "Mediated backends", SMALL_BOLD, (751, 610), "backends", "ma"),
        ("fixtures-text", "fixtures", SMALL_BOLD, (751, 651), "backend-fixtures", "ma"),
        ("mcp-text", "MCP stdio", SMALL_BOLD, (751, 693), "backend-mcp", "ma"),
        ("denied-text", "DENIED: no backend dispatch", SMALL_BOLD, (479, 778), "denied", "ma"),
        ("outside-title", "OUTSIDE THE HARNESS", SMALL_BOLD, (74, 612), "outside", None),
        (
            "outside-text",
            "network • filesystem\n• subprocess\n• native MCP client",
            SMALL,
            (74, 642),
            "outside",
            None,
        ),
        (
            "sidecar-title",
            "Optional grounded SLM adjudicator",
            BODY_BOLD,
            (1099, 790),
            "sidecar",
            "ma",
        ),
        ("sidecar-planned", "PLANNED / NOT SHIPPED", LABEL, (1099, 824), "sidecar", "ma"),
        (
            "sidecar-bottom",
            "No arrow to verdict: it does not set CI status.",
            SMALL_BOLD,
            (1099, 958),
            "sidecar",
            "ma",
        ),
        ("evidence-copy-label", "read-only evidence copy", SMALL, (660, 792), None, None),
        (
            "observe-title",
            "OBSERVE VS ENFORCEMENT",
            LABEL,
            (78, 904),
            "observe-enforcement",
            None,
        ),
        (
            "observe-body",
            "Observe mode records violations after dispatch.\nEnforcement mode can deny configured requests before backend dispatch.",
            BODY,
            (78, 934),
            "observe-enforcement",
            None,
        ),
        (
            "observe-footnote",
            "Both modes persist ordered evidence for deterministic evaluation.",
            SMALL,
            (78, 992),
            "observe-enforcement",
            None,
        ),
    ]
    for index, line in enumerate(
        [
            "required / forbidden tools",
            "precedence",
            "per-tool call budgets",
            "outcome-relative call counts",
            "argument subset + JSON Schema",
            "derived $fromResult references",
            "call-scoped selectors",
            "argument uniqueness",
            "confirmation binding",
            "outcome shape",
            "duration",
        ]
    ):
        text_runs.append((f"evaluator-assertion-{index}", line, SMALL, (944, 456 + index * 22), "evaluator", None))
    for index, line in enumerate(
        [
            "Small Language Model sidecar",
            "advisory by default",
            "local only",
            "grounded on recorded evidence",
        ]
    ):
        text_runs.append((f"sidecar-bullet-{index}", line, SMALL, (936, 858 + index * 22), "sidecar", None))

    for name, value, font, xy, parent, anchor in text_runs:
        if parent:
            rect = by_name[parent]["rect"]
            max_width = rect[2] - rect[0] - 24
            for line in value.splitlines():
                if text_width(draw, line, font) > max_width:
                    violations.append(f"text overflow: {name} in {parent}")
        bounds = text_bounds(draw, xy, value, font, anchor=anchor)
        for box_name, box in by_name.items():
            if skip_text_box(parent, box_name):
                continue
            if intersects(bounds, box["rect"]):
                violations.append(f"text/box intersection: {name} x {box_name}")

    if violations:
        for violation in violations:
            print(f"LAYOUT VIOLATION: {violation}")
        raise AssertionError(f"architecture layout audit failed: {len(violations)} violations")
    print("Architecture layout audit passed: 0 intersecting pairs, 0 text overflows")


def render_architecture():
    width, height = 1800, 1100
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw_header(
        draw,
        width,
        "Hybrid architecture: deterministic core + local SLM sidecar.",
        "The core decides the exit code; the planned SLM path can only advise from recorded evidence.",
        [
            ("DETERMINISTIC CORE", BLUE, WHITE),
            ("SLM SIDECAR PLANNED", AMBER, WHITE),
            ("LOCAL ONLY", GREEN, WHITE),
        ],
    )

    write(draw, (54, 236), "01  AGENT", LABEL, BLUE)
    write(draw, (54, 264), "Unmodified process", SMALL, MUTED)
    draw.line((54, 294, 292, 294), fill=GRID, width=2)
    write(draw, (330, 236), "02  HARNESS-MEDIATED PATH", LABEL, BLUE)
    write(draw, (330, 264), "Adapter, recorder, evaluator, backend mediation", SMALL, MUTED)
    draw.line((330, 294, 1296, 294), fill=GRID, width=2)
    write(draw, (1332, 236), "03  VERDICT", LABEL, GREEN)
    write(draw, (1332, 264), "Exit code plus replayable report", SMALL, MUTED)
    draw.line((1332, 294, 1718, 294), fill=GRID, width=2)

    harness = (318, 312, 1296, 748)
    rounded(draw, harness, "#F8FBFF", BLUE, 18, 3)
    write(draw, (342, 332), "AGENT DOCTOR HARNESS BOUNDARY", LABEL, BLUE)
    write(
        draw,
        (342, 360),
        "Fixture/MCP backends are controlled only through this boundary.",
        SMALL,
        MUTED,
    )

    node(
        draw,
        (54, 374, 292, 512),
        "Agent under test",
        "unmodified; emits tool requests and final output",
        BLUE_LIGHT,
        BLUE,
    )
    node(
        draw,
        (346, 400, 612, 554),
        "Adapter / transport",
        "",
        WHITE,
        NAVY,
    )
    rounded(draw, (368, 462, 590, 506), BLUE_LIGHT, BLUE, 8, 2)
    write(draw, (479, 473), "stdio JSONL", SMALL_BOLD, BLUE, anchor="ma")
    rounded(draw, (368, 518, 590, 542), GREEN_LIGHT, GREEN, 8, 2)
    write(draw, (479, 521), "real MCP stdio server", SMALL_BOLD, GREEN, anchor="ma")

    node(
        draw,
        (652, 394, 880, 548),
        "Evidence recorder",
        "append-only • sequenced • redacted",
        GREEN_LIGHT,
        GREEN,
    )
    node(
        draw,
        (898, 342, 1268, 704),
        "Deterministic evaluator",
        "",
        BLUE_LIGHT,
        BLUE,
    )
    write(draw, (1083, 398), "AUTHORITATIVE", LABEL, RED, anchor="ma")
    write(
        draw,
        (1083, 426),
        "Only this layer decides the exit code.",
        SMALL_BOLD,
        NAVY,
        anchor="ma",
    )
    assertions = [
        "required / forbidden tools",
        "precedence",
        "per-tool call budgets",
        "outcome-relative call counts",
        "argument subset + JSON Schema",
        "derived $fromResult references",
        "call-scoped selectors",
        "argument uniqueness",
        "confirmation binding",
        "outcome shape",
        "duration",
    ]
    bullet_list(draw, 924, 456, assertions, BLUE, MUTED, SMALL, 22)

    node(
        draw,
        (1332, 386, 1718, 548),
        "Verdict + evidence file",
        "exit code plus replayable local JSON report",
        GREEN_LIGHT,
        GREEN,
    )
    write(draw, (1525, 500), "exit 0 / 1 / 2 / 3", MONO_BOLD, NAVY, anchor="ma")

    arrow(draw, (292, 443), (346, 443))
    arrow(draw, (612, 474), (652, 474))
    arrow(draw, (850, 474), (898, 474))
    arrow(draw, (1268, 474), (1332, 474), GREEN)

    policy = (346, 610, 612, 720)
    rounded(draw, policy, AMBER_LIGHT, AMBER, 12, 2)
    write(draw, (479, 628), "Dispatch policy", BODY_BOLD, AMBER, anchor="ma")
    write(draw, (479, 664), "observe = record only\nenforcement = fail closed", SMALL, MUTED, anchor="ma")
    arrow(draw, (479, 554), (479, 610), AMBER)

    backends = (652, 592, 850, 730)
    rounded(draw, backends, WHITE, GREEN, 12, 2)
    write(draw, (751, 610), "Mediated backends", SMALL_BOLD, GREEN, anchor="ma")
    rounded(draw, (674, 646, 828, 676), GREEN_LIGHT, GREEN, 7, 2)
    write(draw, (751, 651), "fixtures", SMALL_BOLD, GREEN, anchor="ma")
    rounded(draw, (674, 688, 828, 718), GREEN_LIGHT, GREEN, 7, 2)
    write(draw, (751, 693), "MCP stdio", SMALL_BOLD, GREEN, anchor="ma")
    orthogonal_arrow(draw, [(612, 666), (632, 666), (632, 662), (652, 662)], GREEN, 3)
    orthogonal_arrow(draw, [(751, 592), (751, 570), (751, 548)], GREEN, 3)

    denied = (326, 766, 632, 820)
    rounded(draw, denied, RED_LIGHT, RED, 10, 2)
    write(draw, (479, 778), "DENIED: no backend dispatch", SMALL_BOLD, RED, anchor="ma")
    orthogonal_arrow(draw, [(479, 720), (479, 744), (479, 766)], RED, 3)

    out_box = (54, 594, 292, 720)
    rounded(draw, out_box, RED_LIGHT, RED, 10, 2)
    write(draw, (74, 612), "OUTSIDE THE HARNESS", SMALL_BOLD, RED)
    write(draw, (74, 642), "network • filesystem\n• subprocess\n• native MCP client", SMALL, MUTED)
    arrow(draw, (173, 512), (173, 594), RED, 3, True)

    sidecar = (888, 770, 1310, 990)
    dashed_panel(draw, sidecar, AMBER_LIGHT, AMBER, 18, 3)
    write(draw, (1099, 790), "Optional grounded SLM adjudicator", BODY_BOLD, AMBER, anchor="ma")
    write(draw, (1099, 824), "PLANNED / NOT SHIPPED", LABEL, RED, anchor="ma")
    bullet_list(
        draw,
        916,
        858,
        [
            "Small Language Model sidecar",
            "advisory by default",
            "local only",
            "grounded on recorded evidence",
        ],
        AMBER,
        MUTED,
        SMALL,
        22,
    )
    orthogonal_arrow(
        draw,
        [(751, 548), (872, 548), (872, 842), (888, 842)],
        AMBER,
        3,
    )
    write(draw, (660, 792), "read-only evidence copy", SMALL, AMBER)
    write(draw, (1099, 958), "No arrow to verdict: it does not set CI status.", SMALL_BOLD, RED, anchor="ma")

    strip = (54, 884, 850, 1020)
    rounded(draw, strip, NAVY, NAVY, 14, 2)
    write(draw, (78, 904), "OBSERVE VS ENFORCEMENT", LABEL, "#8CC9FF")
    write(
        draw,
        (78, 934),
        "Observe mode records violations after dispatch.\nEnforcement mode can deny configured requests before backend dispatch.",
        BODY,
        WHITE,
    )
    write(
        draw,
        (78, 992),
        "Both modes persist ordered evidence for deterministic evaluation.",
        SMALL,
        "#AFC0CA",
    )

    write(
        draw,
        (54, 1030),
        "Denied = prevented harness dispatch  •  Finding after dispatch = detected risk  •  Dashed paths = outside control or planned sidecar",
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
    assert_architecture_layout(draw)
    return save_png_if_changed(image, ARCHITECTURE)


ASSETS.mkdir(parents=True, exist_ok=True)
overview_changed = render_overview()
architecture_changed = render_architecture()
print(
    f"{'Rendered' if overview_changed else 'Unchanged'} {OVERVIEW.relative_to(ROOT)} (1600x900)"
)
print(
    f"{'Rendered' if architecture_changed else 'Unchanged'} {ARCHITECTURE.relative_to(ROOT)} (1800x1100)"
)
