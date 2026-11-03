<div align="center">
  <br />
  <h1>🧠 Sentirix Core API</h1>
  <p><strong>The High-Performance, AI-Native Customer Support & Helpdesk Backend Engine</strong></p>
  <p><em>Equipped with real-time sentiment triage, Google Gemini Copilot, multi-tenant pods, and bi-directional WebSockets.</em></p>

  <p>
    <a href="https://github.com/sentirix-ai/sentirix-core/actions"><img src="https://img.shields.io/github/actions/workflow/status/sentirix-ai/sentirix-core/ci.yml?branch=main&style=flat-square&logo=github-actions&label=CI%20Build" alt="CI Status" /></a>
    <a href="https://nestjs.com"><img src="https://img.shields.io/badge/Framework-NestJS%2012-E0234E?style=flat-square&logo=nestjs" alt="NestJS" /></a>
    <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/Language-TypeScript%205-3178C6?style=flat-square&logo=typescript" alt="TypeScript" /></a>
    <a href="https://www.prisma.io"><img src="https://img.shields.io/badge/ORM-Prisma%206-2D3748?style=flat-square&logo=prisma" alt="Prisma" /></a>
    <a href="https://www.postgresql.org"><img src="https://img.shields.io/badge/Database-PostgreSQL%2016-336791?style=flat-square&logo=postgresql" alt="PostgreSQL" /></a>
    <a href="https://ai.google.dev"><img src="https://img.shields.io/badge/AI-Google%20Gemini-8E75C2?style=flat-square&logo=google" alt="Google Gemini" /></a>
    <a href="https://socket.io"><img src="https://img.shields.io/badge/Realtime-Socket.io-010101?style=flat-square&logo=socket.io" alt="Socket.io" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="MIT License" /></a>
  </p>
  <br />
</div>

---

## ⚡ What is Sentirix Core?

**Sentirix Core** is the backend orchestration engine powering the Sentirix AI customer support platform. Built on top of **NestJS**, **Prisma ORM**, and **PostgreSQL 16**, it acts as the central hub for:
* **AI-Native Sentiment Triage**: Scoring tickets dynamically (`FRUSTRATED`, `URGENT`, `NEUTRAL`, `POSITIVE`) using the official `@google/genai` SDK.
* **Bi-directional WebSocket Engine**: Delivering sub-millisecond agent collision detection, live typing indicators, and message broadcasts.
* **Multi-Pod Enterprise Workspaces**: Supporting isolated workspace pods, pod transfers, leadership hierarchies, and fine-grained Role-Based Access Control (`ADMIN`, `AGENT`, `CUSTOMER`).
* **High-Throughput RESTful APIs**: Fully documented with Swagger / OpenAPI schemas.

---

## 🏗️ Architecture & Data Flow

```mermaid
flowchart TD
    Client[Sentirix Web Frontend] -->|REST API / JWT| Gateway[NestJS API Controllers]
    Client <-->|WebSocket Events| SocketGateway[Socket.io Gateway]
    
    subgraph Core Engine [Sentirix Core Engine]
        Gateway --> AuthMod[Auth & JWT Module]
        Gateway --> TicketMod[Ticket & Pod Service]
        Gateway --> AIMod[Gemini AI Engine]
        Gateway --> AnalyticsMod[Executive Analytics Service]
        
        SocketGateway --> CollisionDetect[Agent Collision & Typing State]
        SocketGateway --> EventBroadcast[Real-Time Event Dispatcher]
    end

    AIMod -->|Inference Stream| Gemini[Google Gemini 2.0 / 2.5 API]
    TicketMod -->|Type-Safe Queries| Prisma[Prisma ORM Client]
    Prisma --> Postgres[(PostgreSQL 16 Alpine)]
```

---

## ✨ Key Features

- **🧠 Google Gemini AI Integration**: Automated customer sentiment triage and smart response suggestions powered by `@google/genai`.
- **⚡ Live Agent Collision Avoidance**: Real-time broadcast alerts when another support engineer is currently viewing or typing on a ticket.
- **🏢 Multi-Pod Enterprise Architecture**: Organize agent teams into dedicated pods with seamless ticket transfers and pod analytics.
- **📊 Real-Time SLA & Resolution Metrics**: Detailed operational reporting tracking ticket velocities, volume spikes, and resolution rates.
- **🐳 1-Click PostgreSQL Orchestration**: Self-contained `docker-compose.yml` pre-configured with persistent storage and healthchecks.
- **📖 OpenAPI / Swagger Docs**: Interactive API documentation generated automatically at `/api/docs`.

---

## 📡 API Reference Overview

| Module | Method | Endpoint | Description |
| :--- | :--- | :--- | :--- |
| **Auth** | `POST` | `/api/v1/auth/register` | Register new organization admin or user |
| **Auth** | `POST` | `/api/v1/auth/login` | Authenticate and issue JWT token |
| **Tickets** | `GET` | `/api/v1/tickets` | Retrieve ticket queue with filter & sentiment |
| **Tickets** | `POST` | `/api/v1/tickets` | Submit new customer support ticket |
| **Tickets** | `POST` | `/api/v1/tickets/:id/messages` | Post public reply or internal staff note |
| **AI** | `POST` | `/api/v1/ai/analyze-ticket` | Run real-time sentiment scoring on demand |
| **AI** | `POST` | `/api/v1/ai/generate-reply` | Generate AI Copilot suggested response |
| **Workspace**| `GET` | `/api/v1/workspace/pods` | List team pods, leaders, and member count |
| **Workspace**| `POST` | `/api/v1/workspace/transfer` | Transfer ticket between department pods |
| **Analytics**| `GET` | `/api/v1/analytics/overview` | Executive SLA, sentiment distribution & metrics |

---

## 🔌 WebSocket Events Reference

The gateway runs at the root host (`ws://localhost:4000`) and supports the following events:

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `ticket:join` | Client $\rightarrow$ Server | `{ ticketId: string }` | Join dedicated ticket room |
| `agent:viewing` | Bidirectional | `{ ticketId, agentName }` | Triggers agent collision badge |
| `agent:typing` | Bidirectional | `{ ticketId, isTyping }` | Live typing indicator broadcast |
| `ticket:message` | Server $\rightarrow$ Client | `{ message: Message }` | Instant real-time message delivery |

---

## 🚀 Quick Start (Local Setup)

### Prerequisites
* [Node.js](https://nodejs.org) (v18.0 or newer)
* [Docker Desktop](https://www.docker.com/products/docker-desktop)
* [Google Gemini API Key](https://aistudio.google.com)

### 1. Start PostgreSQL with Docker
```bash
docker compose up -d
```
*PostgreSQL will be accessible at `localhost:5432`.*

### 2. Configure Environment Variables
Copy the example configuration:
```bash
cp .env.example .env
```
Update your `.env` with your Gemini API key and credentials:
```env
PORT=4000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/db_sentrix?schema=public"
JWT_SECRET="your-ultra-secure-jwt-secret-min-32-chars"
GEMINI_API_KEY="your-google-gemini-api-key"
CORS_ORIGIN="http://localhost:3000"
```

### 3. Install & Migrate Database
```bash
npm install
npx prisma generate
npx prisma db push
```

### 4. Run Development Server
```bash
npm run start:dev
```
*API will be listening at `http://localhost:4000`.*  
*Swagger UI is available at `http://localhost:4000/api/docs`.*

---

## 🧪 Testing

```bash
# Run unit & integration tests
npm run test

# Run End-to-End (E2E) tests
npm run test:e2e

# Run test coverage report
npm run test:cov
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
