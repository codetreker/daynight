import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasPaintedPdfMarker, readPdfPixels } from './helpers/pdf-pixels';

const image = () => {
  const width = 601;
  const height = 361;
  const data = new Uint8ClampedArray(width * height * 4);
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })));
  vi.stubGlobal('OffscreenCanvas', class {
    readonly width = width;
    readonly height = height;
    getContext = () => ({ drawImage: vi.fn(), getImageData: () => ({ width, height, data }) });
  });
  const paint = (left: number, top: number, rectangleWidth: number, rectangleHeight: number, color = [17, 203, 149, 255]) => {
    for (let y = top; y < top + rectangleHeight; y++) {
      for (let x = left; x < left + rectangleWidth; x++) data.set(color, (y * width + x) * 4);
    }
  };
  return { paint, close, read: () => readPdfPixels('') };
};

afterEach(() => vi.unstubAllGlobals());

describe('native PDF paint evidence', () => {
  it('measures the full-page rectangle independently of the viewer thumbnail', async () => {
    const fixture = image();
    fixture.paint(94, 124, 112, 27);
    fixture.paint(332, 151, 237, 58);
    const pixels = await fixture.read();
    expect(pixels).toMatchObject({ width: 601, height: 361, matchingPixels: 16770,
      pixels: 13746, markerWidth: 237, markerHeight: 58, density: 1,
      bounds: { left: 332, top: 151, right: 568, bottom: 208 } });
    expect(pixels.components.map(({ pixels }) => pixels)).toEqual([13746, 3024]);
    expect(hasPaintedPdfMarker(pixels)).toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('rejects a small thumbnail and disconnected color fragments without combining them', async () => {
    const fixture = image();
    fixture.paint(80, 100, 50, 15);
    for (let y = 150; y < 350; y += 3) {
      for (let x = 300; x < 600; x += 3) fixture.paint(x, y, 1, 1);
    }
    const pixels = await fixture.read();
    expect(pixels.matchingPixels).toBeGreaterThan(1600);
    expect(pixels.components[0]!.pixels).toBe(750);
    expect(pixels.pixels).toBe(1);
    expect(hasPaintedPdfMarker(pixels)).toBe(false);
  });

  it('rejects the actual viewer thumbnail alone even though it exceeds the size and density gates', async () => {
    const fixture = image();
    fixture.paint(94, 124, 112, 27);
    const pixels = await fixture.read();
    expect(pixels.matchingPixels).toBe(3024);
    expect(pixels.components[0]).toMatchObject({ pixels: 3024, width: 112, height: 27, density: 1 });
    expect(pixels.pixels).toBe(0);
    expect(hasPaintedPdfMarker(pixels)).toBe(false);
  });

  it('accepts a centered main page without a sidebar when its scrollbar offsets the marker center left', async () => {
    const fixture = image();
    fixture.paint(100, 120, 395, 95);
    const pixels = await fixture.read();
    expect(pixels.components).toHaveLength(1);
    expect((pixels.bounds!.left + pixels.bounds!.right) / 2).toBeLessThan(pixels.width / 2);
    expect(hasPaintedPdfMarker(pixels)).toBe(true);
  });

  it('rejects a connected sparse shape even when its pixel count and bounds exceed the size gates', async () => {
    const fixture = image();
    fixture.paint(320, 100, 200, 1);
    for (let x = 320; x < 520; x += 5) fixture.paint(x, 100, 1, 100);
    const pixels = await fixture.read();
    expect(pixels.pixels).toBeGreaterThan(1600);
    expect(pixels.markerWidth).toBe(200);
    expect(pixels.markerHeight).toBe(100);
    expect(pixels.density).toBeLessThan(0.95);
    expect(hasPaintedPdfMarker(pixels)).toBe(false);
  });

  it('preserves the exact RGB tolerance and minimum alpha', async () => {
    const fixture = image();
    fixture.paint(350, 100, 100, 30, [21, 199, 153, 250]);
    fixture.paint(350, 200, 100, 30, [22, 203, 149, 255]);
    fixture.paint(350, 250, 100, 30, [17, 203, 149, 249]);
    const pixels = await fixture.read();
    expect(pixels.matchingPixels).toBe(3000);
    expect(pixels.components).toHaveLength(1);
    expect(hasPaintedPdfMarker(pixels)).toBe(true);
  });

  it('rejects an unpainted PDF frame', async () => {
    const pixels = await image().read();
    expect(pixels).toMatchObject({ matchingPixels: 0, pixels: 0, markerWidth: 0, markerHeight: 0, density: 0, bounds: null, components: [] });
    expect(hasPaintedPdfMarker(pixels)).toBe(false);
  });
});
