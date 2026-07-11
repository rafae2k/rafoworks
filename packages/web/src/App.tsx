import { useEffect, useState } from "react"

// The web shell: a minimal dashboard that reads from the api worker. It demonstrates
// the "React served as a Worker, talking to the API" pattern — swap this for your real
// dashboard. The api is a separate worker, so point VITE_API_BASE at it.

interface Order {
  id: string
  sourceOrderId: string
  status: string
  customerName: string | null
  totalCents: number
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787"

const money = (cents: number) => (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })

export function App() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/orders`)
      .then((r) => (r.ok ? (r.json() as Promise<Order[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setOrders)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <main>
      <header>
        <h1>rafoworks</h1>
        <p className="sub">An event-driven integration platform on Cloudflare Workers.</p>
      </header>

      <section className="card">
        <h2>Recent orders</h2>
        {error && (
          <p className="note error">
            Couldn't reach the API at <code>{API_BASE}</code> ({error}). Is <code>pnpm dev</code> running, and is
            VITE_API_BASE pointed at it?
          </p>
        )}
        {!error && orders === null && <p className="note">Loading…</p>}
        {!error && orders?.length === 0 && (
          <p className="note">No orders yet. Send a webhook (see the README) and one appears here.</p>
        )}
        {orders && orders.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Customer</th>
                <th className="right">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.sourceOrderId}</td>
                  <td>
                    <span className={`badge badge-${o.status}`}>{o.status}</span>
                  </td>
                  <td>{o.customerName ?? "—"}</td>
                  <td className="right">{money(o.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}
