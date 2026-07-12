# TanStack Router - File-Based Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing for type-safe navigation.

## 📁 File Structure

Routes are defined as files in the `src/routes/` directory:

```
src/routes/
├── __root.tsx          # Root layout with navigation
├── index.tsx           # Home page (/)
├── about.tsx           # About page (/about)
└── posts.$postId.tsx   # Dynamic route (/posts/:postId)
```

## 🚀 How It Works

### 1. Route Files

Each file in `src/routes/` becomes a route:

- `index.tsx` → `/` (home page)
- `about.tsx` → `/about`
- `posts.$postId.tsx` → `/posts/:postId` (dynamic parameter)
- `blog/index.tsx` → `/blog`
- `blog/post.tsx` → `/blog/post`

### 2. Creating a Route

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return <div>About Page</div>
}
```

### 3. Dynamic Routes

Use `$` prefix for dynamic parameters:

**File:** `posts.$postId.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/posts/$postId')({
  component: Post,
})

function Post() {
  const { postId } = Route.useParams()
  return <div>Post ID: {postId}</div>
}
```

### 4. Navigation

Use the `Link` component for type-safe navigation:

```tsx
import { Link } from '@tanstack/react-router'

// Simple link
<Link to="/about">About</Link>

// Link with params (type-safe!)
<Link to="/posts/$postId" params={{ postId: '123' }}>
  View Post
</Link>

// Active link styling
<Link
  to="/about"
  activeProps={{
    style: { color: 'blue', textDecoration: 'underline' }
  }}
>
  About
</Link>
```

### 5. Programmatic Navigation

```tsx
import { useNavigate } from '@tanstack/react-router'

function MyComponent() {
  const navigate = useNavigate()
  
  const goToPost = () => {
    navigate({ to: '/posts/$postId', params: { postId: '123' } })
  }
  
  return <button onClick={goToPost}>Go to Post</button>
}
```

## 🔧 Configuration

### Vite Plugin

The TanStack Router Vite plugin automatically generates type-safe route trees:

```ts
// vite.config.ts
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

export default defineConfig({
  plugins: [
    TanStackRouterVite(), // Must be before react()
    react(),
  ],
})
```

### Generated Files

The plugin generates `src/routeTree.gen.ts` automatically. This file:
- Should NOT be edited manually
- Is excluded from git (in `.gitignore`)
- Provides full TypeScript type safety
- Regenerates on every route file change

## 📋 Route Patterns

### Index Routes
`index.tsx` becomes the default route for its directory:
- `routes/index.tsx` → `/`
- `routes/blog/index.tsx` → `/blog`

### Nested Routes
Create nested layouts with directories:
```
routes/
├── __root.tsx
├── dashboard.tsx
└── dashboard/
    ├── index.tsx      # /dashboard
    ├── settings.tsx   # /dashboard/settings
    └── users.tsx      # /dashboard/users
```

### Dynamic Segments
- `$paramName` → Required parameter
- `_` prefix → Layout route (no path segment)

Examples:
- `posts.$postId.tsx` → `/posts/:postId`
- `users.$userId.edit.tsx` → `/users/:userId/edit`

### Catch-All Routes
Use `$.tsx` for 404 pages:
```tsx
// routes/$.tsx
export const Route = createFileRoute('/$')({
  component: NotFound,
})
```

## 🛠️ Advanced Features

### Route Loaders
Load data before rendering:

```tsx
export const Route = createFileRoute('/posts/$postId')({
  loader: async ({ params }) => {
    const post = await fetchPost(params.postId)
    return { post }
  },
  component: Post,
})

function Post() {
  const { post } = Route.useLoaderData()
  return <div>{post.title}</div>
}
```

### Search Params
Type-safe search parameters:

```tsx
import { z } from 'zod'

const searchSchema = z.object({
  page: z.number().catch(1),
  filter: z.string().optional(),
})

export const Route = createFileRoute('/posts')({
  validateSearch: searchSchema,
  component: Posts,
})

function Posts() {
  const { page, filter } = Route.useSearch()
  // page and filter are fully typed!
}
```

### Before Load (Authentication)
Protect routes with guards:

```tsx
export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ context }) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({ to: '/login' })
    }
  },
})
```

## 🐛 Development Tools

The router includes built-in devtools (visible in development):
- Route tree visualization
- Current route information
- Search params inspector
- Active matches

Access them via the floating TanStack Router button in the bottom-right corner.

## 📚 Resources

- [TanStack Router Docs](https://tanstack.com/router/latest)
- [File-Based Routing Guide](https://tanstack.com/router/latest/docs/framework/react/guide/file-based-routing)
- [Type Safety Guide](https://tanstack.com/router/latest/docs/framework/react/guide/type-safety)


