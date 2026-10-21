#!/usr/bin/env node
/**
 * Rewrites virtual-hosted S3 requests into path-style ones.
 *
 * The CDK CLI always publishes assets to `<bucket>.s3.<region>.amazonaws.com`
 * (virtual-hosted). fakecloud 0.51 only parses path-style requests, so those
 * uploads fail with "InvalidBucketName: bucket name is required".
 *
 * Point `AWS_ENDPOINT_URL_S3` at this proxy; it turns
 *   Host: <bucket>.localhost:4567 /<key>
 * into
 *   Host: localhost:4566         /<bucket>/<key>
 *
 * Nothing else is touched: headers, body and the response stream are forwarded
 * verbatim. Signed requests keep working because fakecloud does not verify
 * SigV4 by default.
 *
 * Usage: node scripts/s3-path-proxy.js [listenPort] [upstreamUrl]
 */
const http = require('http')

const LISTEN_PORT = Number(process.argv[2] ?? 4567)
const UPSTREAM = process.argv[3] ?? 'http://localhost:4566'

const server = http.createServer((request, response) => {
  const host = String(request.headers.host ?? '').split(':')[0]
  const bucket = host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : ''
  const target = new URL(`${bucket ? `/${bucket}` : ''}${request.url}`, UPSTREAM)

  const upstream = http.request(
    target,
    { method: request.method, headers: { ...request.headers, host: target.host } },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    },
  )

  upstream.on('error', (error) => {
    response.writeHead(502, { 'content-type': 'text/plain' })
    response.end(`s3-path-proxy: ${error.message}\n`)
  })

  request.pipe(upstream)
})

server.listen(LISTEN_PORT, () => {
  console.log(`s3-path-proxy listening on ${LISTEN_PORT} -> ${UPSTREAM}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
