const crypto = require('crypto')
const { execFileSync } = require('child_process')

const { sign } = require('@electron/osx-sign')
const plist = require('plist')

function shortHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').toUpperCase()
}

module.exports = async function signMas(opts) {
  if (!opts?.provisioningProfile) throw new Error('MAS signing requires a provisioning profile')
  const profile = plist.parse(execFileSync(
    '/usr/bin/security',
    ['cms', '-D', '-i', opts.provisioningProfile],
    { encoding: 'utf8' },
  ))
  const certificate = profile?.DeveloperCertificates?.[0]
  if (!certificate) throw new Error('Provisioning profile has no DeveloperCertificates entry')
  const identity = shortHash(Buffer.from(certificate))
  return sign({
    ...opts,
    identity,
    identityValidation: false,
    preAutoEntitlements: false,
  })
}
