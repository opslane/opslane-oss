import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main>
      <button id="trigger-error" onClick={() => {
        throw new Error('codemod browser event');
      }}>
        Trigger error
      </button>
    </main>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
