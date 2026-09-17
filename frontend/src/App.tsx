import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/Home'
import PracticePage from './pages/Practice'
import ReviewPage from './pages/Review'
import HistoryPage from './pages/History'
import ComparePage from './pages/Compare'
import ProfilePage from './pages/Profile'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="practice/:sessionId" element={<PracticePage />} />
        <Route path="review/:sessionId" element={<ReviewPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>
    </Routes>
  )
}

export default App
