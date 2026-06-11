# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.5.x   | :white_check_mark: |
| < 0.5   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in AgentsMCP, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. **Email**: Send a detailed report to [security@agentsmcp.com](mailto:security@agentsmcp.com)
3. **Include**:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Response Timeline

- **Acknowledgement**: Within 48 hours
- **Initial Assessment**: Within 5 business days
- **Fix & Disclosure**: Within 30 days (coordinated with reporter)

## Security Measures

AgentsMCP implements the following security measures:

- **API Key Authentication**: SHA-256 hashed keys with timing-safe comparison
- **GitHub OAuth**: CSRF-protected with state parameter validation
- **Loopback Validation**: CLI redirect URLs restricted to localhost only
- **Rate Limiting**: Per-IP and per-API-key rate limiting
- **Security Headers**: Helmet.js (HSTS, X-Frame-Options, X-Content-Type-Options)
- **Input Validation**: Zod schema validation on all request bodies
- **SQL Injection Prevention**: Parameterized queries only (no string interpolation)
- **Structured Logging**: Request correlation IDs for audit trails
- **Graceful Shutdown**: Connection draining prevents data loss

## Scope

This policy applies to:
- The `agentsmcp` npm package
- The hosted cloud service at agentsmcp.com
- All official client SDKs (TypeScript, Python)

Third-party integrations and forks are not covered.
