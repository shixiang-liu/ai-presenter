import { Outlet, Link, useLocation } from 'react-router-dom'
import { Home, History, Mic, BarChart3, User } from 'lucide-react'

export default function Layout() {
  const location = useLocation()
  const isPracticing = location.pathname.startsWith('/practice')

  // Hide navigation during practice
  if (isPracticing) {
    return <Outlet />
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-glass border-b border-neutral-100">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link to="/" className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center">
                <Mic className="w-5 h-5 text-white" />
              </div>
              <span className="text-xl font-semibold text-primary">AI演说家</span>
            </Link>

            {/* Nav Links */}
            <div className="flex items-center gap-2">
              <NavLink to="/" icon={<Home className="w-4 h-4" />}>
                首页
              </NavLink>
              <NavLink to="/history" icon={<History className="w-4 h-4" />}>
                历史记录
              </NavLink>
              <NavLink to="/compare" icon={<BarChart3 className="w-4 h-4" />}>
                横向对比
              </NavLink>
              <NavLink to="/profile" icon={<User className="w-4 h-4" />}>
                演讲者画像
              </NavLink>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pt-16">
        <Outlet />
      </main>
    </div>
  )
}

function NavLink({ 
  to, 
  children, 
  icon 
}: { 
  to: string
  children: React.ReactNode
  icon?: React.ReactNode 
}) {
  const location = useLocation()
  const isActive = location.pathname === to

  return (
    <Link
      to={to}
      className={`
        flex items-center gap-2 px-4 py-2 rounded-xl font-medium transition-all duration-200
        ${isActive 
          ? 'bg-primary text-white' 
          : 'text-neutral-600 hover:bg-neutral-100'
        }
      `}
    >
      {icon}
      {children}
    </Link>
  )
}
