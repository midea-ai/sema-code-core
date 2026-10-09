export const TOOL_DESCRIPTION = `Generate an image from a text prompt. The generated image is shown to the user automatically.

Usage:
- Describe the subject, style, composition and lighting in detail. When the shape matters, state the aspect ratio or orientation in the prompt (e.g. "wide 16:9 banner", "square icon").
- Each call generates one image; there is no count parameter. Call the tool again only for a different image or for a variation the user asked for.

Cut-out assets (characters and their poses, props, items, icons, UI pieces, anything that ends up on a transparent background):
- All cut-out assets of a task go on one sprite sheet in one call, mixed kinds included. Do not split them into several sheets, and do not generate one asset first as a style reference for the rest: the shared style prefix keeps the set consistent. A second sheet is only for assets that cannot fit on the first at a usable size, or that are requested later.
- Sheet prompt recipe, in this order:
  1. the shared style prefix: material, lighting, palette, shape language;
  2. "a strict N-column by M-row grid containing exactly K separate assets";
  3. the numbered list of assets in row-major order, each with its own distinguishing details;
  4. "each asset centered in its own equal-size invisible cell, similar visual weight, generous padding on all sides";
  5. "every asset fully visible and completely separated from the others, including any glow or floating parts";
  6. "true transparent background, no checkerboard";
  7. end with "no overlapping, no cropping, no connecting elements, no grid lines, no labels, no text, no UI panels, no surrounding scene".
  Set transparent=true. Then view the sheet, crop the assets apart with a script by the alpha bounding box of each asset (not by assumed equal cells), check that the count matches K, and save each as its own file.
- Only scenes, backgrounds and full mockups get their own call.
- transparent=true is the right choice for sheets and single cut-outs. Never for scenes or photos. Some models ignore it and return an opaque image.

References and output:
- Pass reference_images to edit an existing image, to keep a character, product or style consistent with an image you generated earlier (use the file path from that result), or to combine subjects from several images. Describe the change relative to the references ("make image 1 nighttime", "put the chair from image 2 into the room of image 1").
- Reference images must be local files whose path you know (generated results, project assets, files the user named). Some models ignore references or reject them; if the call fails, tell the user instead of retrying without them.
- Pass output_path only when the user explicitly said where to save the image. Otherwise omit it and do not mention the file path in your reply.
- The file extension follows the actual image format returned by the provider, and existing files are never overwritten, so the saved path may differ from output_path. Always use the path from the result.
`
