import { createRoot } from "react-dom/client";

function Landing() {
  return (
    <main>
      <h1>Enqiu</h1>
      <p>A type-safe background job queue for browsers, Node.js, and Bun.</p>
      <p>Start with the in-memory driver and move to Redis without changing your job API.</p>
      <pre><code>npm install enqiu</code></pre>
      <nav aria-label="Project links">
        <a href="https://github.com/moji2002/enqiu">GitHub</a>
        {" · "}
        <a href="https://www.npmjs.com/package/enqiu">npm</a>
      </nav>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Landing root element is missing");
createRoot(root).render(<Landing />);
