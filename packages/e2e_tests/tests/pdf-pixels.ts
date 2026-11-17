export type PdfMarkerComponent = {
  pixels: number;
  width: number;
  height: number;
  density: number;
  bounds: { left: number; top: number; right: number; bottom: number };
};

export type PdfPixels = {
  width: number;
  height: number;
  pixels: number;
  markerWidth: number;
  markerHeight: number;
  density: number;
  bounds: PdfMarkerComponent['bounds'] | null;
  matchingPixels: number;
  components: PdfMarkerComponent[];
};

export const hasPaintedPdfMarker = (pixels: PdfPixels): boolean =>
  pixels.pixels >= 1600 && pixels.markerWidth >= 80 && pixels.markerHeight >= 20 && pixels.density >= 0.95;

export const readPdfPixels = async (base64: string): Promise<PdfPixels> => {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('PDF evidence requires a browser 2D canvas.');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const matching = new Uint8Array(width * height);
  let matchingPixels = 0;
  for (let index = 0; index < matching.length; index++) {
    const offset = index * 4;
    if (Math.abs(data[offset]! - 17) <= 4 && Math.abs(data[offset + 1]! - 203) <= 4
      && Math.abs(data[offset + 2]! - 149) <= 4 && data[offset + 3]! >= 250) {
      matching[index] = 1;
      matchingPixels++;
    }
  }
  const components: PdfMarkerComponent[] = [];
  const queue = new Int32Array(matching.length);
  for (let start = 0; start < matching.length; start++) {
    if (matching[start] === 0) continue;
    matching[start] = 0;
    queue[0] = start;
    let pending = 1;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let cursor = 0; cursor < pending; cursor++) {
      const index = queue[cursor]!;
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, index - width, index + width]) {
        if (neighbor < 0 || neighbor >= matching.length || matching[neighbor] === 0) continue;
        matching[neighbor] = 0;
        queue[pending++] = neighbor;
      }
    }
    const componentWidth = right - left + 1;
    const componentHeight = bottom - top + 1;
    components.push({ pixels: pending, width: componentWidth, height: componentHeight,
      density: pending / (componentWidth * componentHeight), bounds: { left, top, right, bottom } });
  }
  components.sort((left, right) => right.pixels - left.pixels);
  // Our fixture centers its rectangle on the 360-point PDF page. The main-page
  // marker reaches the frame's right half with or without the viewer sidebar;
  // the sidebar thumbnail must not establish main-page paint by itself.
  const marker = components.find(({ bounds }) => bounds.right >= width / 2);
  return { width, height, pixels: marker === undefined ? 0 : marker.pixels,
    markerWidth: marker === undefined ? 0 : marker.width, markerHeight: marker === undefined ? 0 : marker.height,
    density: marker === undefined ? 0 : marker.density, bounds: marker === undefined ? null : marker.bounds,
    matchingPixels, components };
};
