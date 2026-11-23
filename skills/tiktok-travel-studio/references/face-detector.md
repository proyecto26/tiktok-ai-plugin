# Optional face detector (`TT_FACE_CMD`)

Faces are scored, and used to aim the 9:16 crop, only when you configure a detector that runs on this machine. This
skill ships none and downloads none: without `TT_FACE_CMD` the faces term is `null`, the crop follows motion (else the
centre), and `score` says `not configured`.

## Contract

`TT_FACE_CMD` is a command template. The skill extracts a JPEG frame (upright, at most 960 px wide; for a video, three
frames at 25, 50 and 75 percent), runs the command with the frame path, and reads **JSON on stdout**:

- A command with `{file}` in it gets the path there; without it the path is appended as the last argument.
- Double quotes group words that contain spaces. No shell is involved, so no pipes or redirects.
- Exit 0 with JSON like `[{"x": 0.41, "y": 0.18, "w": 0.12, "h": 0.2}]`, or `{"boxes": [...]}`, or `[]` for no faces.
  `x`, `y` are the top-left corner, `w`, `h` the size, as **fractions of the image** (0 to 1). Values above 1 are
  read as pixels of the frame that was passed.
- Anything else (non-zero exit, no JSON, 60 s timeout) is reported as `faces not scored: TT_FACE_CMD failed (...)`
  and scoring and rendering continue without faces.

## Example

```bash
export TT_FACE_CMD='python "/path/to/my_faces.py" {file}'
```

where `my_faces.py` is the user's own script around whatever detector is already installed. The focus is the
area-weighted centre of all boxes found. The faces term is 1 when a face is found and 0.4 when none is (no face is not
a defect in a landscape shot).
