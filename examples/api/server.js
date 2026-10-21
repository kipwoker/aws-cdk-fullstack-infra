// Tiny demo API so the stack has something to serve on day one.
// Replace it with your own service (see README: "Bring your own app").
const http = require('http')

const port = Number(process.env.PORT || 8080)
const version = process.env.APP_VERSION || 'dev'

const server = http.createServer((req, res) => {
  // The demo frontend lives on a different origin (CloudFront vs API Gateway).
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('content-type', 'application/json')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ status: 'ok', version }))
    return
  }

  res.writeHead(200)
  res.end(
    JSON.stringify({
      message: 'Hello from aws-cdk-fullstack-infra',
      version,
      apiDomain: process.env.API_DOMAIN,
      appDomain: process.env.APP_DOMAIN,
      database: process.env.DATABASE_HOST ? 'configured' : 'missing',
      analytics: process.env.ANALYTICS_URL || 'disabled',
    }),
  )
})

server.listen(port, () => console.log(`demo api ${version} listening on :${port}`))
