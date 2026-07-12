import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'

export const Route = createRootRoute({
  component: () => (
    <>
      <div style={{ padding: '1rem', borderBottom: '1px solid #e0e0e0' }}>
        <nav style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <Link
            to="/"
            style={{ textDecoration: 'none', color: '#646cff', fontWeight: 500 }}
            activeProps={{
              style: {
                color: '#535bf2',
                textDecoration: 'underline',
              },
            }}
          >
            Home
          </Link>
          <Link
            to="/about"
            style={{ textDecoration: 'none', color: '#646cff', fontWeight: 500 }}
            activeProps={{
              style: {
                color: '#535bf2',
                textDecoration: 'underline',
              },
            }}
          >
            About
          </Link>
          <Link
            to="/posts/$postId"
            params={{ postId: 'example' }}
            style={{ textDecoration: 'none', color: '#646cff', fontWeight: 500 }}
            activeProps={{
              style: {
                color: '#535bf2',
                textDecoration: 'underline',
              },
            }}
          >
            Example Post
          </Link>
        </nav>
      </div>
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
})

