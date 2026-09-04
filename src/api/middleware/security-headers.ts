import type { MiddlewareHandler } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

/**
 * Browser hardening for the dashboard and the API. The CSP allows only our
 * own scripts and styles (Vite emits hashed same-origin bundles; the pages
 * carry inline `style=` attributes, hence `unsafe-inline` on styles only),
 * `connect-src 'self'` covers fetch and the SSE streams, images may come
 * from launch metadata over https, and nothing may frame us.
 */
export function securityHeaders(): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'same-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginResourcePolicy: 'same-origin',
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: [],
      usb: [],
    },
  })
}
