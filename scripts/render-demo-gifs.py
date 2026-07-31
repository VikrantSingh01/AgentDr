from pathlib import Path
import re
import sys

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
WIDTH = 1120
HEIGHT = 630
PADDING = 44
LINE_HEIGHT = 27
MAX_LINES = 18
TEXT_WIDTH = WIDTH - (PADDING * 2)
HEADER_TITLE_X = 150
HEADER_TITLE_Y = 39
HEADER_SUBTITLE_Y = 42
HEADER_RIGHT_X = WIDTH - PADDING
HEADER_GAP = 28
SUBTITLE_MAX_FONT_SIZE = 17
SUBTITLE_MIN_FONT_SIZE = 12
BACKGROUND = "#10151c"
CHROME = "#1c2530"
TEXT = "#d9e2ec"
MUTED = "#8fa2b5"
GREEN = "#57d38c"
RED = "#ff6b6b"
YELLOW = "#f2c14e"


def font(size: int, bold: bool = False):
    candidates = [
        Path("C:/Windows/Fonts/CascadiaMono.ttf"),
        Path("C:/Windows/Fonts/consola.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    ]
    if bold:
        candidates.insert(0, Path("C:/Windows/Fonts/CascadiaMono-Bold.ttf"))
        candidates.insert(1, Path("C:/Windows/Fonts/consolab.ttf"))
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


BODY_FONT = font(21)
TITLE_FONT = font(22, bold=True)


def color_for(line: str):
    stripped = line.strip()
    if stripped.startswith("PASS") or "passed" in stripped.lower():
        return GREEN
    if stripped.startswith("FAIL") or "CRITICAL" in stripped or "ERROR" in stripped:
        return RED
    if stripped.startswith("$"):
        return YELLOW
    if stripped.startswith("Evidence:") or stripped.startswith("#"):
        return MUTED
    return TEXT


def normalize(text: str):
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = text.replace(str(ROOT), ".").replace(str(ROOT).replace("\\", "/"), ".")
    return [line.rstrip() for line in text.replace("\r\n", "\n").splitlines()]


def wrap_line(draw: ImageDraw.ImageDraw, line: str):
    if not line:
        return [""]

    wrapped = []
    remaining = line
    continuation = "  "
    while draw.textlength(remaining, font=BODY_FONT) > TEXT_WIDTH:
        end = len(remaining)
        while end > 1 and draw.textlength(remaining[:end], font=BODY_FONT) > TEXT_WIDTH:
            end -= 1
        break_at = max(
            remaining.rfind(" ", 0, end + 1),
            remaining.rfind("/", 0, end + 1),
        )
        if break_at < end // 2:
            break_at = end
        elif remaining[break_at] == "/":
            break_at += 1
        wrapped.append(remaining[:break_at].rstrip())
        remaining = continuation + remaining[break_at:].lstrip()
    wrapped.append(remaining)
    return wrapped


def wrap_lines(lines: list[str]):
    measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    return [wrapped for line in lines for wrapped in wrap_line(measure, line)]


def text_width(draw: ImageDraw.ImageDraw, text: str, text_font):
    left, _, right, _ = draw.textbbox((0, 0), text, font=text_font)
    return right - left


def ellipsize(draw: ImageDraw.ImageDraw, text: str, text_font, max_width: int):
    ellipsis = "…"
    if text_width(draw, ellipsis, text_font) > max_width:
        raise ValueError("Header subtitle has no drawable space")
    if text_width(draw, text, text_font) <= max_width:
        return text
    low = 0
    high = len(text)
    while low < high:
        mid = (low + high + 1) // 2
        candidate = f"{text[:mid].rstrip()}{ellipsis}"
        if text_width(draw, candidate, text_font) <= max_width:
            low = mid
        else:
            high = mid - 1
    return f"{text[:low].rstrip()}{ellipsis}"


def fit_subtitle(draw: ImageDraw.ImageDraw, subtitle: str, max_width: int):
    for size in range(SUBTITLE_MAX_FONT_SIZE, SUBTITLE_MIN_FONT_SIZE - 1, -1):
        subtitle_font = font(size)
        if text_width(draw, subtitle, subtitle_font) <= max_width:
            return subtitle, subtitle_font
    subtitle_font = font(SUBTITLE_MIN_FONT_SIZE)
    return ellipsize(draw, subtitle, subtitle_font, max_width), subtitle_font


def checked_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    text_font,
    fill: str,
    label: str,
    min_x: int = 0,
    max_x: int = WIDTH,
    min_y: int = 0,
    max_y: int = HEIGHT,
):
    bbox = draw.textbbox(xy, text, font=text_font)
    if bbox[0] < min_x or bbox[1] < min_y or bbox[2] > max_x or bbox[3] > max_y:
        raise ValueError(f"{label} text would render outside bounds: {bbox}")
    draw.text(xy, text, font=text_font, fill=fill)
    return bbox


def draw_header(draw: ImageDraw.ImageDraw, title: str, subtitle: str):
    title_bbox = checked_text(
        draw,
        (HEADER_TITLE_X, HEADER_TITLE_Y),
        title,
        TITLE_FONT,
        TEXT,
        "title",
        max_x=HEADER_RIGHT_X,
    )
    subtitle_left_limit = title_bbox[2] + HEADER_GAP
    max_subtitle_width = HEADER_RIGHT_X - subtitle_left_limit
    if max_subtitle_width <= 0:
        raise ValueError("Header title leaves no room for subtitle")
    fitted_subtitle, subtitle_font = fit_subtitle(draw, subtitle, max_subtitle_width)
    subtitle_bbox_at_origin = draw.textbbox((0, 0), fitted_subtitle, font=subtitle_font)
    subtitle_x = HEADER_RIGHT_X - subtitle_bbox_at_origin[2]
    checked_text(
        draw,
        (subtitle_x, HEADER_SUBTITLE_Y),
        fitted_subtitle,
        subtitle_font,
        MUTED,
        "subtitle",
        min_x=subtitle_left_limit,
        max_x=HEADER_RIGHT_X,
    )


def animation_step(line_count: int):
    return 2 if line_count > 14 else 1


def draw_frame(title: str, subtitle: str, visible_lines: list[str], cursor: bool):
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((18, 18, WIDTH - 18, HEIGHT - 18), radius=16, fill=CHROME)
    for index, dot_color in enumerate((RED, YELLOW, GREEN)):
        x = 48 + index * 28
        draw.ellipse((x, 43, x + 15, 58), fill=dot_color)
    draw_header(draw, title, subtitle)
    draw.line((38, 78, WIDTH - 38, 78), fill="#344253", width=1)

    lines = visible_lines[-MAX_LINES:]
    y = 102
    for line in lines:
        checked_text(
            draw,
            (PADDING, y),
            line,
            BODY_FONT,
            color_for(line),
            "body",
            max_x=WIDTH - PADDING,
        )
        y += LINE_HEIGHT
    if cursor:
        draw.rectangle((PADDING, min(y + 2, HEIGHT - 52), PADDING + 12, min(y + 23, HEIGHT - 31)), fill=GREEN)
    return image


def render(input_path: Path, output_path: Path, title: str, subtitle: str):
    lines = wrap_lines(normalize(input_path.read_text(encoding="utf-8")))
    if len(lines) > MAX_LINES:
        raise ValueError(f"{input_path} needs {len(lines)} display lines; maximum is {MAX_LINES}")
    frames = []
    durations = []
    visible = []
    step = animation_step(len(lines))
    pending_duration = 0
    for index, line in enumerate(lines, start=1):
        visible.append(line)
        pending_duration += 460 if line else 180
        if index % step == 0 or index == len(lines):
            frames.append(draw_frame(title, subtitle, visible, True))
            durations.append(pending_duration)
            pending_duration = 0
    final_frame = draw_frame(title, subtitle, visible, False)
    frames.append(final_frame)
    durations.append(3000)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    static_path = output_path.with_suffix(".png")
    final_frame.save(static_path, optimize=True)
    print(
        f"Rendered {output_path.relative_to(ROOT)} ({len(frames)} frames) "
        f"and {static_path.relative_to(ROOT)}"
    )


def main():
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: render-demo-gifs.py <input.txt> <output.gif> <title> <subtitle>"
        )
    input_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    title = sys.argv[3]
    subtitle = sys.argv[4]
    render(input_path, output_path, title, subtitle)


if __name__ == "__main__":
    main()