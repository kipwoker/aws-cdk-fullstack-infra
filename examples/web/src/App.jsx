import { useEffect, useState } from 'react'

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

function Status({ state }) {
  if (!API_URL) {
    return <span className="pill warn">VITE_API_URL not set</span>
  }
  if (state.status === 'loading') {
    return <span className="pill">Checking API…</span>
  }
  if (state.status === 'error') {
    return <span className="pill bad">API unreachable</span>
  }
  return <span className="pill good">API healthy · v{state.data?.version ?? '?'}</span>
}

export default function App() {
  const [state, setState] = useState({ status: API_URL ? 'loading' : 'unconfigured', data: null, error: null })

  useEffect(() => {
    if (!API_URL) return

    const controller = new AbortController()
    fetch(`${API_URL}/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((data) => setState({ status: 'ok', data, error: null }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ status: 'error', data: null, error: error.message })
      })

    return () => controller.abort()
  }, [])

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">AWS CDK Fullstack Infra</p>
        <h1>Sample frontend, deployed to S3 + CloudFront.</h1>
        <p className="lede">
          This page is a private bucket behind CloudFront. It calls the Fargate API through API Gateway and
          shows the live health response below.
        </p>

        <div className="status-row">
          <Status state={state} />
          <a className="link" href={`${API_URL}/health`} target="_blank" rel="noreferrer">
            {API_URL ? 'Open /health' : 'Set VITE_API_URL'}
          </a>
        </div>

        <dl className="facts">
          <div>
            <dt>Frontend</dt>
            <dd>CloudFront + private S3</dd>
          </div>
          <div>
            <dt>API</dt>
            <dd>{API_URL || 'not configured'}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>{state.data?.database ?? 'waiting for API'}</dd>
          </div>
          <div>
            <dt>Analytics</dt>
            <dd>{state.data?.analytics ?? 'waiting for API'}</dd>
          </div>
        </dl>

        {state.error && <p className="error">Last error: {state.error}</p>}

        <footer>
          <span>Deployed with aws-cdk-fullstack-infra</span>
          <span className="dot" />
          <span>Route 53 · ACM · ECS · RDS · S3</span>
        </footer>
      </section>
    </main>
  )
}
