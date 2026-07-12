export function hasExactlyOneActiveGitHubLogin(rawStatus, expectedLogin) {
  const activeLogins = []
  let currentLogin
  let currentIsActive = false

  function finishAccount() {
    if (currentLogin && currentIsActive) activeLogins.push(currentLogin)
  }

  for (const line of rawStatus.split(/\r?\n/u)) {
    const account = line.match(
      /Logged in to github\.com account ([^\s(]+)/u,
    )
    if (account) {
      finishAccount()
      currentLogin = account[1]
      currentIsActive = false
      continue
    }
    if (/Active account:\s*true\b/u.test(line)) {
      currentIsActive = true
    }
  }
  finishAccount()

  return (
    activeLogins.length === 1 && activeLogins[0] === expectedLogin
  )
}
