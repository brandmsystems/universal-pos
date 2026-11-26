import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { tabletSlugFromPath } from '../../lib/restaurantPath.js';
import { wantsInstallHelp } from '../../lib/posApp.js';
import { linkPosManifest, registerPosWorker, watchInstallPrompt } from '../../services/posApp.js';

const root = document.getElementById('root');
if (!root) throw new Error('no #root to mount into');

// The installable app, before the first render: the browser may offer the
// install as soon as the manifest is read. Only on a restaurant's own POS address.
const slug = tabletSlugFromPath('pos');
if (slug !== null) {
  linkPosManifest(slug);
  watchInstallPrompt({ hold: wantsInstallHelp(window.location.search) });
  void registerPosWorker(slug);
}

createRoot(root).render(<App />);
