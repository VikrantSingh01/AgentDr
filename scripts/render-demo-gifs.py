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
SMALL_FONT = font(17)


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


def draw_frame(title: str, subtitle: str, visible_lines: list[str], cursor: bool):
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((18, 18, WIDTH - 18, HEIGHT - 18), radius=16, fill=CHROME)
    for index, dot_color in enumerate((RED, YELLOW, GREEN)):
        x = 48 + index * 28
        draw.ellipse((x, 43, x + 15, 58), fill=dot_color)
    draw.text((150, 39), title, font=TITLE_FONT, fill=TEXT)
    draw.text((WIDTH - 315, 42), subtitle, font=SMALL_FONT, fill=MUTED)
    draw.line((38, 78, WIDTH - 38, 78), fill="#344253", width=1)

    lines = visible_lines[-MAX_LINES:]
    y = 102
    for line in lines:
        draw.text((PADDING, y), line, font=BODY_FONT, fill=color_for(line))
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
    for line in lines:
        visible.append(line)
        frames.append(draw_frame(title, subtitle, visible, True))
        durations.append(460 if line else 180)
    final_frame = draw_frame(title, subtitle, visible, False)
    frames.extend(
        [
            draw_frame(title, subtitle, visible, True),
            final_frame,
            draw_frame(title, subtitle, visible, True),
        ]
    )
    durations.extend([900, 300, 3000])
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