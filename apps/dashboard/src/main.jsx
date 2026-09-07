import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { session } from './api.js';
import App from './App.jsx';
import Login from './Login.jsx';
import Overview from './Overview.jsx';
import Queue from './Queue.jsx';
import Report from './Report.jsx';
import RiskMap from './RiskMap.jsx';
import './index.css';

/**
 * The whole router. Which routes exist is a function of the role — but that is
 * navigation, not security: every one of these screens is fed by an endpoint
 * that re-derives the caller's scope from the token (`apps/api/dashboard.js`).
 * Deleting a link here hides nothing that the API would otherwise hand over.
 */
function Root() {
  const [user, setUser] = useState(() => session.read()?.user ?? null);

  if (!user) {
    return (
      <Login
        onSignedIn={(payload) => {
          session.write(payload);
          setUser(payload.user);
        }}
      />
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          element={
            <App
              user={user}
              onSignOut={() => {
                session.clear();
                setUser(null);
              }}
            />
          }
        >
          <Route index element={<Overview user={user} />} />
          <Route path="queue" element={<Queue />} />
          <Route path="map" element={<RiskMap />} />
          <Route path="reports/:id" element={<Report />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
