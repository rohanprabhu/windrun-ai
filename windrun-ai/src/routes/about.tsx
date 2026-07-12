import { createFileRoute } from '@tanstack/react-router'
import '../App.css'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return (
    <div className="App">
      <h1>About Page</h1>
      <p>
        This is an example about page using TanStack Router's file-based routing.
      </p>
      <div className="card">
        <p>
          Create new routes by adding files to the <code>src/routes</code> directory.
        </p>
        <ul style={{ textAlign: 'left', maxWidth: '600px', margin: '0 auto' }}>
          <li>
            <code>src/routes/index.tsx</code> → <code>/</code> (home page)
          </li>
          <li>
            <code>src/routes/about.tsx</code> → <code>/about</code>
          </li>
          <li>
            <code>src/routes/posts/$postId.tsx</code> → <code>/posts/:postId</code> (dynamic route)
          </li>
          <li>
            <code>src/routes/blog/index.tsx</code> → <code>/blog</code>
          </li>
        </ul>
      </div>
    </div>
  )
}


