import { createFileRoute } from '@tanstack/react-router'
import '../App.css'

export const Route = createFileRoute('/posts/$postId')({
  component: Post,
})

function Post() {
  const { postId } = Route.useParams()

  return (
    <div className="App">
      <h1>Post {postId}</h1>
      <div className="card">
        <p>
          This is a dynamic route example. The <code>$postId</code> in the filename creates a dynamic parameter.
        </p>
        <p>
          Current post ID: <strong>{postId}</strong>
        </p>
        <div style={{ marginTop: '2rem' }}>
          <p>Try these URLs:</p>
          <ul style={{ textAlign: 'left', maxWidth: '400px', margin: '1rem auto' }}>
            <li><code>/posts/1</code></li>
            <li><code>/posts/hello-world</code></li>
            <li><code>/posts/tanstack-router</code></li>
          </ul>
        </div>
      </div>
    </div>
  )
}


