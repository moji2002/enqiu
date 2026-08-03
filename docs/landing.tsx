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
      <section aria-labelledby="benchmark-dashboard">
        <h2 id="benchmark-dashboard">Benchmark dashboard</h2>
        <p>No benchmark results have been published yet.</p>
        <table>
          <caption>Queue benchmark status</caption>
          <thead>
            <tr>
              <th scope="col">Library</th>
              <th scope="col">Throughput</th>
              <th scope="col">p95 latency</th>
              <th scope="col">Memory</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {(["Enqiu", "BullMQ", "Bee-Queue", "pg-boss"] as const).map((library) => (
              <tr key={library}>
                <th scope="row">{library}</th>
                <td>Pending</td>
                <td>Pending</td>
                <td>Pending</td>
                <td>Benchmark not run</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Landing root element is missing");
createRoot(root).render(<Landing />);
