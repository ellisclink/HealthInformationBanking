import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './parse' // connect to Parse once, before anything else
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
