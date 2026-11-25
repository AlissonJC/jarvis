import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { NAME_DOTTED } from './lib/identity'
import { LOCALE } from './lib/locale'

// The page title and language follow the settings (VITE_ASSISTANT_NAME, VITE_LANG).
document.title = `${NAME_DOTTED}.`
document.documentElement.lang = LOCALE.tag

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
