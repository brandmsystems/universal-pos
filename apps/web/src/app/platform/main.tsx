import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('no #root in platform.html');
createRoot(root).render(<App />);
