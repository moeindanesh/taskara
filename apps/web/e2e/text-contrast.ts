import { expect, type Locator } from '@playwright/test';

/** Measure rendered text against its composited background, including translucent notices. */
export async function expectReadableText(root: Locator) {
  await expect.poll(() => root.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    function rgba(color: string) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).map((value) => value / 255);
    }
    function blend(front: number[], back: number[]) {
      return front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3])).concat(1);
    }
    function luminance(color: number[]) {
      const linear = color.slice(0, 3).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    return [element, ...element.querySelectorAll<HTMLElement>('*')].flatMap((node) => {
      const field = node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && ['text', 'search', 'email', 'tel', 'url', 'number'].includes(node.type)) ? node : null;
      const ownText = field ? field.value || field.placeholder : [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join('').trim();
      if (!ownText || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || node.closest('[disabled], [aria-disabled="true"], [aria-hidden="true"], .sr-only')) return [];
      const bounds = node.getBoundingClientRect();
      if (bounds.width <= 1 || bounds.height <= 1) return [];
      const ancestors: Element[] = [];
      for (let current: Element | null = node; current; current = current.parentElement) ancestors.unshift(current);
      let background = [1, 1, 1, 1];
      for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background);
      const style = getComputedStyle(node, field && !field.value && field.placeholder ? '::placeholder' : null);
      const foreground = blend(rgba(style.color), background);
      const a = luminance(foreground), b = luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && parseInt(style.fontWeight) >= 700);
      return ratio < (large ? 3 : 4.5) ? [{ text: ownText.slice(0, 100), ratio: Number(ratio.toFixed(2)), className: node.getAttribute('class') }] : [];
    });
  }), { message: 'Visible text should retain readable contrast on the active surface' }).toEqual([]);
}
