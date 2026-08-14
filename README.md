# Prime Telecoms FSM

A Telecommunications Field Service Management System built as a serverless Single-Page Application (SPA).

## Production Architecture

```
                 PRIME TELECOMS FSM SYSTEM
                             │
              ┌──────────────┴──────────────┐
              │                             │
           VERCEL                        FIREBASE
     (Frontend Hosting)             (Backend Services)
              │                             │
     ┌────────┼────────┐           ┌────────┼────────┐
     │        │        │           │        │        │
   HTML5    CSS3   JavaScript   Firebase Firestore Storage
                                  Auth
              │                             │
              └──────────────┬──────────────┘
                             │
                      Manager / Technician
                             │
                  ┌──────────┴──────────┐
                  │                     │
            Manager Dashboard     Technician Dashboard
```

## Technology Stack

- **Frontend Hosting**: Vercel (`https://primetelecoms-fsm.vercel.app`)
- **Authentication**: Firebase Authentication (Email/Password + Google Provider)
- **Database & Identity**: Cloud Firestore (Project: `planning-with-ai-f9dd4`)
- **UI Framework**: Native HTML5, Vanilla CSS3, Modern JavaScript SPA
- **Backend/Django/PostgreSQL**: Completely Removed

## Repository Structure

```
primetelecoms_fsm/
│
├── index.html              ← Main Single-Page Application entrypoint
├── css/
│   └── style.css           ← Modern responsive theme
├── js/
│   ├── firebase-client.js  ← Firebase Web SDK initializer
│   ├── data.js             ← Firestore data access layer & Auth helpers
│   └── app.js              ← Single-Page App router & Dashboard views
├── firestore.rules         ← Firestore Security Rules
├── firebase.json           ← Firebase project configuration
├── vercel.json             ← Vercel SPA route rewrite rules
└── README.md
```

## Security & Access Control

1. **Role-Based Routing**: Single-Page App routing guards in `js/app.js` enforce that technicians cannot access manager views (`#staff`, `#jobs/new`).
2. **Firestore Security Rules**: Database rules in `firestore.rules` enforce organization-level data isolation and prevent client-side role manipulation.