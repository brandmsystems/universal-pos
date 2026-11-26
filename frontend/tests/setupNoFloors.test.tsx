import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { SetupStep, type SetupStepId } from '../src/features/settings/admin/setup/Setup.js';

/**
 * Basic has no tables, and the server refuses its floor lists with 402. The
 * setup steps that are not the floor plan -- Printers, Kitchens, Menu items,
 * categories -- must not ask for floors or floor types at all; only the
 * floor-plan steps, which a plan with tables shows, read them.
 */

let root: Root | null = null;
let host: HTMLElement;
let paths: string[] = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

async function open(step: SetupStepId): Promise<void> {
  paths = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    paths.push(new URL(String(input), 'http://x').pathname);
    return Response.json({ rows: [], more: false });
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SetupStep api={createApi(createStore())} step={step} branchId="b1" onChanged={() => undefined} />);
  });
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const floorReads = (): string[] => paths.filter((p) => p.endsWith('/admin/floors') || p.endsWith('/admin/floor-types'));

describe('setup steps and the floor plan', () => {
  for (const step of ['printers', 'kitchens', 'categories', 'items'] as const) {
    it(`${step}: reads no floors or floor types`, async () => {
      await open(step);
      expect(paths.length).toBeGreaterThan(0);
      expect(floorReads()).toEqual([]);
    });
  }

  it('the floor plan steps still read them', async () => {
    await open('tables');
    expect(floorReads().sort()).toEqual(['/api/t/admin/floor-types', '/api/t/admin/floors']);
  });
});
