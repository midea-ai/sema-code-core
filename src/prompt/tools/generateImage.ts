export const TOOL_DESCRIPTION = `Generate an image from a text prompt. The generated image is shown to the user automatically.

Usage:
- Describe the subject, style, composition and lighting in detail. When the shape matters, state the aspect ratio or orientation in the prompt (e.g. "wide 16:9 banner", "square icon").
- Each call generates one image. Call the tool again for variations.
- For a set of small same-kind assets (icons, game items such as coins or stones, UI badges), generate them as one sprite sheet instead of one call per item: state the grid explicitly ("3x4 grid, 12 cells of equal size, one item centered in each cell, generous even spacing"), set transparent=true, and end the prompt with "no text, no labels". Then crop the cells apart with a script and save each as its own file.
- Set transparent=true only for isolated subjects (icons, sprites, cut-out assets). Never for scenes or photos: the whole image may come back semi-transparent. Some models ignore it and return an opaque image.
- Pass output_path only when the user explicitly said where to save the image. Otherwise omit it and do not mention the file path in your reply.
- The file extension follows the actual image format returned by the provider, and existing files are never overwritten, so the saved path may differ from output_path. Always use the path from the result.
- Generation can take from a few seconds to a few minutes.
`
