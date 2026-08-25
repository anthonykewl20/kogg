# Ranex — Product Direction & Feature Specification

**Status:** Strategic product direction  
**Foundation:** Eclipse Theia  
**Core:** Ranex Kernel + Ranex Orchestration Engine  
**Primary goal:** Build a multi-project engineering control center for autonomous software development.

---

## 1. Product Vision

Ranex should not be positioned as another AI code editor or as an open-source Cursor clone.

The intended product is:

> **Ranex is the engineering control plane for autonomous software development.**

The IDE is one surface of the product. The deeper system coordinates multiple AI providers and agents across multiple projects while connecting:

```text
Requirement
    ↓
Specification
    ↓
Visual Architecture
    ↓
Visual Workflow
    ↓
Agent Orchestration
    ↓
Multi-Project Execution
    ↓
Real Code Changes
    ↓
Independent Verification
    ↓
Evidence
    ↓
Ranex Verdict
    ↓
Merge
    ↓
Architecture + Engineering Memory
```

The existing Ranex kernel remains the authority. Agents and models are replaceable workers, not the source of truth.

---

# 2. Core Ranex Requirements

These are the requirements that define the product.

## 2.1 Multi-Project Engineering Harness

Projects must be first-class objects.

### Required capabilities

- Multiple projects open and managed from one application
- Multiple repositories per project
- Multi-root projects
- Multiple Git worktrees
- Project-specific terminals
- Project-specific agents
- Project-specific environments
- Project-specific policies
- Persistent project state
- Fast project switching
- Global project dashboard
- Search across projects
- Project activity/status
- Cross-project task coordination
- Cross-project dependency awareness

### Desired project model

```text
Ranex
│
├── Project A
│   ├── Repository A1
│   ├── Repository A2
│   ├── Worktrees
│   ├── Agents
│   ├── Tasks
│   └── Evidence
│
├── Project B
│   ├── Repository B1
│   └── ...
│
└── Global Agent / Task Manager
```

The key difference from a normal IDE is that the **engineering project**, not merely the folder, becomes the unit of organization.

---

# 3. Agent Orchestration

This is the heart of Ranex.

Ranex should be provider-neutral and role-oriented.

A model is assigned a role instead of being the identity of the product.

## 3.1 Example

```text
User
  ↓
Claude — Orchestrator / Planner
  ↓
┌──────────────┬──────────────┬──────────────┐
│              │              │
GPT            Gemini        Claude
Worker         Research      Reviewer
│              │              │
└──────────────┴──────────────┘
                ↓
        Ranex Kernel
                ↓
      Independent Verification
                ↓
             Verdict
```

## 3.2 Agent roles

Potential built-in roles:

- Orchestrator
- Architect
- Planner
- Worker
- Researcher
- Test writer
- Test executor
- Reviewer
- Security reviewer
- Performance reviewer
- Documentation agent
- Migration agent
- Release agent
- Integrator
- Verification agent

## 3.3 Provider abstraction

Potential providers:

- Anthropic
- OpenAI
- Google
- OpenRouter
- Ollama
- Local models
- OpenCode
- Claude Code
- Codex
- Gemini CLI
- Other compatible agents

The orchestration engine should not require a specific vendor.

### Important principle

```text
Provider ≠ Role
Role ≠ Model
Agent ≠ Authority
```

Example:

```text
Architecture → Claude
Implementation → GPT
Research → Gemini
Security → Model X
Review → Model Y
Verification → Deterministic Ranex checks
```

The assignments should be configurable per workflow, project, task, or policy.

---

# 4. Visual Workflow System

Visual workflows should be **executable**, not merely documentation.

## 4.1 Workflow example

```text
┌──────────────┐
│ User Request │
└──────┬───────┘
       ↓
┌──────────────┐
│ Architecture │
│ Claude       │
└──────┬───────┘
       ↓
┌──────────────┐
│ Implement    │
│ GPT          │
└──────┬───────┘
       ↓
   ┌───┴────────┐
   ↓            ↓
┌──────┐    ┌──────────┐
│ Test │    │ Security │
│ GPT  │    │ Gemini   │
└───┬──┘    └────┬─────┘
    └──────┬─────┘
           ↓
   ┌──────────────┐
   │ Verification │
   │ Ranex Kernel  │
   └──────┬───────┘
          ↓
       Verdict
```

## 4.2 Required workflow capabilities

- Visual DAG editor
- Drag-and-drop nodes
- Agent nodes
- Human approval nodes
- Tool nodes
- Check nodes
- Conditional branches
- Retry policies
- Parallel execution
- Sequential execution
- Timeouts
- Failure handling
- Manual intervention
- Project/worktree selection
- Provider/model selection
- Versioned workflows
- Workflow templates
- Workflow execution history
- Workflow replay
- Workflow comparison
- Workflow cancellation
- Workflow pause/resume

## 4.3 Critical design principle

A workflow diagram should be executable.

If the user creates:

```text
Research → Build → Review → Test → Merge
```

that graph should be the actual runtime definition.

It should be versioned and auditable.

---

# 5. Visual Code Architecture

The architecture view should be generated from the actual project rather than being merely an AI-generated diagram.

## 5.1 Architecture sources

Potential inputs:

- Source code
- Imports
- Dependency graphs
- LSP information
- Git history
- APIs
- Database schemas
- Runtime information
- Container/service metadata
- Test relationships

## 5.2 Example

```text
                  ┌────────────┐
                  │ Frontend   │
                  └─────┬──────┘
                        ↓
                  ┌────────────┐
                  │ API        │
                  └─────┬──────┘
             ┌──────────┼──────────┐
             ↓          ↓          ↓
          Auth       Payments     Users
             │          │          │
             └──────────┼──────────┘
                        ↓
                   PostgreSQL
```

## 5.3 Architecture interactions

Clicking an architecture component should expose:

- Source files
- Classes/functions
- Dependencies
- APIs
- Database relationships
- Current tasks
- Agents that modified it
- Recent commits
- Tests
- Verification status
- Relevant architectural decisions

Example:

```text
Payment Service
    ↓
src/payment/
    ↓
Task #1842
    ↓
Agent #27
    ↓
Commit abc123
    ↓
Tests 32, 33, 34
    ↓
Verification PASS
```

---

# 6. Kanban / Engineering Operations Board

Ranex should include a native Kanban board.

However:

> **Kanban is a required feature, not the primary differentiator.**

The market already has agent-centric boards and task management.

## 6.1 Suggested columns

```text
BACKLOG
   ↓
PLANNING
   ↓
READY
   ↓
BUILDING
   ↓
REVIEW
   ↓
VERIFICATION
   ↓
BLOCKED
   ↓
DONE
```

## 6.2 Ranex task card

```text
┌────────────────────────────────┐
│ #1842 OAuth implementation     │
│                                │
│ Orchestrator: Claude           │
│ Worker: GPT                    │
│ Reviewer: Gemini               │
│                                │
│ Progress: ███████████░ 82%     │
│ Evidence: 11 / 14              │
│ Worktree: wt/oauth-1842        │
│                                │
│ ⚠ 2 verification failures      │
└────────────────────────────────┘
```

The Kanban card should link directly into:

- Task specification
- Agent workflow
- Agent sessions
- Files changed
- Git diff
- Evidence
- Verification
- Verdict

---

# 7. Market Table-Stakes

These features should exist because the current AI development market increasingly expects them.

They should not be the primary Ranex differentiation.

## 7.1 Agent features

- Parallel agents
- Agent sessions
- Agent history
- Resume
- Cancellation
- Notifications
- Agent handoffs
- Worktree isolation
- Background agents
- Cloud agents
- Terminal agents
- MCP
- Skills
- Tool permissions
- Model selection

## 7.2 Developer environment

- Code editor
- LSP
- Git
- GitHub integration
- Integrated terminal
- Multiple terminals
- Search
- File explorer
- Debugging
- Build/test execution
- Tasks
- Environment variables
- Extensions
- Dev containers

## 7.3 Modern agent capabilities

Potentially expected by users:

- Browser automation
- Computer use
- Screenshots
- Browser console
- Network inspection
- Application testing
- Remote/cloud environments
- Build logs
- Test artifacts
- Video artifacts

## 7.4 Project management

- Kanban
- Tasks
- Milestones
- Queues
- Agent status
- Background jobs
- Team activity

---

# 8. Ranex Differentiators

These are the areas where Ranex should deliberately be different.

## 8.1 Provider-Neutral Agent Orchestration

Instead of selling:

> "Ranex uses model X."

Sell:

> **"Ranex assembles the right AI team for the job."**

Example:

```text
Architecture       → Claude
Implementation     → GPT
Research           → Gemini
Security           → Specialized model
Testing            → Another model
Verification       → Ranex Kernel
```

Providers should be replaceable without changing the workflow.

---

# 9. Executable Visual Workflows

Most workflow diagrams are documentation.

Ranex workflows should be executable specifications.

Capabilities:

- Design workflow
- Save workflow
- Version workflow
- Run workflow
- Pause workflow
- Resume workflow
- Replay workflow
- Compare runs
- Fork workflow
- Inspect node results
- Inspect failures
- Modify workflow and rerun

The workflow becomes an operational artifact.

---

# 10. Agent Observability

Do not bury developers in enormous agent transcripts.

Show an operational timeline:

```text
08:41  Orchestrator created plan
08:43  Worker started
08:47  Worker changed 12 files
08:49  Tests failed
08:50  Worker attempted repair
08:52  Reviewer found regression
08:54  Worker repaired
08:56  Verification passed
08:57  MERGED
```

The system should answer:

- What happened?
- Where did it fail?
- What changed?
- Which agent caused the issue?
- What was the first meaningful failure?
- What evidence exists?
- Why was the final verdict reached?

---

# 11. Agent Economics

Make AI usage measurable.

Example:

```text
TASK #1842

Claude Orchestrator   $0.82
GPT Worker            $1.43
Gemini Review         $0.21
Security Review       $0.08

TOTAL                 $2.54
```

Track:

- Token usage
- Cost
- Latency
- Success rate
- Retry rate
- Verification failures
- Provider/model performance
- Cost per task
- Cost per successful change

Potential future optimization:

```text
Quality × Cost × Latency
```

Ranex could eventually route work automatically based on these metrics.

---

# 12. Evidence-Backed Verification

This is where the existing Ranex kernel should remain central.

The product should visibly distinguish:

```text
Agent says:
"Done"
```

from:

```text
Ranex:
Evidence verified
Required checks passed
Verdict = PASS
```

The governing chain should remain:

```text
Agent
  ↓
Actual repository state
  ↓
Independent checks
  ↓
Evidence
  ↓
Ranex Kernel
  ↓
Verdict
  ↓
Merge
```

The worker must not be able to self-approve its own result.

---

# 13. Cross-Project Intelligence

This is a major opportunity created by the multi-project requirement.

Suppose:

```text
Project A = Frontend
Project B = Backend
Project C = Shared library
Project D = Infrastructure
Project E = Mobile application
```

A change to authentication should be analyzed across the project graph.

Desired flow:

```text
Request
  ↓
Cross-project impact analysis
  ↓
Architecture graph
  ↓
Task DAG
  ↓
Agent allocation
  ↓
Parallel worktrees
  ↓
Cross-project verification
  ↓
Integrated verdict
```

This turns "multiple projects" from a UI capability into an intelligence capability.

---

# 14. Engineering Memory

Ranex should store structured engineering knowledge rather than generic chat memories.

Example:

```text
Decision #381

OAuth tokens must never be stored
in localStorage.

Reason:
Security architecture decision.

Affected:
frontend/auth/*
backend/auth/*

Approved:
2026-08-19

Evidence:
commit 82f31a
```

Agents should be able to consult this automatically.

If a new proposal conflicts:

```text
⚠ ARCHITECTURAL CONFLICT

The proposed implementation conflicts
with Decision #381.

Review before continuing.
```

Potential memory categories:

- Architecture decisions
- Security policies
- Engineering constraints
- Project conventions
- API contracts
- Database rules
- Deployment rules
- Operational lessons
- Verified facts

---

# 15. Architecture-Aware Agent Orchestration

The orchestrator should understand the architecture graph.

Instead of seeing only:

```text
500 files
```

it should understand:

```text
Frontend
  ↓
API Gateway
  ↓
Domain Services
  ↓
Persistence
  ↓
Infrastructure
```

A request such as:

> "Add subscription billing"

could become:

```text
Frontend
    ↓
Billing API
    ↓
Subscription Domain
    ↓
Payment Provider
    ↓
Database
    ↓
Webhook Processor
```

Ranex can then construct the workflow around those boundaries.

---

# 16. Full Ranex Product Architecture

```text
                         RANEX DESKTOP
                              │
                            THEIA
                 ┌────────────┼────────────┐
                 │            │            │
             Workspace      Editor      Terminal
                 │            │            │
                 └────────────┼────────────┘
                              │
                      RANEX UI LAYER
                 ┌────────────┼────────────┐
                 │            │            │
              Projects      Kanban      Architecture
                 │                         │
              Workflows ──────────────────┘
                 │
                 ▼
              RANEX ORCHESTRATOR
                 │
       ┌─────────┼─────────┐
       │         │         │
    Claude      GPT      Gemini
  Orchestrator Worker    Reviewer
       │         │         │
       └─────────┼─────────┘
                 │
            Worker Adapters
                 │
       ┌─────────┼─────────┐
       │         │         │
    OpenCode   Claude     Codex
    /Agents    Code       /Agents
                 │
                 ▼
            Git Worktrees
                 │
                 ▼
             RANEX KERNEL
                 │
       ┌─────────┼─────────┐
       │         │         │
    Evidence  Verdict    Merge
       │         │         │
       └─────────┼─────────┘
                 │
                 ▼
       Engineering Memory /
       Architecture State
```

---

# 17. Foundation Decision

## Selected foundation: Eclipse Theia

Reason:

Ranex requires more than a fast editor.

The product needs:

- Multi-project environment
- Workspace infrastructure
- Extensibility
- Integrated terminals
- Git
- IDE functionality
- AI integration
- Custom panels/widgets
- Visual workflow interfaces
- Visual architecture interfaces
- Native product-specific UI
- A platform on which Ranex becomes the product

Theia should therefore be treated as:

> **the IDE and application framework underneath Ranex.**

Ranex itself owns:

- Project management semantics
- Agent orchestration
- Provider/model routing
- Workflow engine
- Visual workflow system
- Visual architecture system
- Evidence
- Verification
- Engineering memory
- Governance
- Kernel authority

---

# 18. What Ranex Should NOT Become

Avoid these positioning traps:

### Not:
> Open-source Cursor

### Not:
> OpenCode with a GUI

### Not:
> Theia with an AI chat panel

### Not:
> Kanban + AI agents

### Not:
> Another multi-agent coding IDE

The existing market already has strong products in these areas.

---

# 19. Proposed Blue-Ocean Positioning

## Product category

**Engineering Control Plane for Autonomous Software Development**

## Core promise

> **Ranex lets teams operate multiple AI agents across multiple software projects while providing a visual map of the work, the architecture, the agents, and the evidence behind every result.**

## Differentiation

The central chain is:

```text
Requirement
    ↓
Specification
    ↓
Architecture
    ↓
Workflow
    ↓
Agent Team
    ↓
Code
    ↓
Verification
    ↓
Evidence
    ↓
Verdict
    ↓
Merge
```

And every layer is connected.

---

# 20. The Most Important Product Concept

The deepest possible Ranex differentiator is not the editor.

It is the **connected engineering graph**:

```text
Requirement
     │
     ▼
Specification
     │
     ▼
Architecture
     │
     ▼
Workflow
     │
     ▼
Agent
     │
     ▼
Task
     │
     ▼
Code Change
     │
     ▼
Test
     │
     ▼
Evidence
     │
     ▼
Verdict
     │
     ▼
Commit / Merge
```

A user should be able to move in either direction.

For example:

> "Why does this function exist?"

should lead to:

```text
Function
 → File
 → Architecture component
 → Task
 → Requirement
```

And:

> "What could break if I change this requirement?"

should lead to:

```text
Requirement
 → Architecture components
 → Repositories
 → Tasks
 → Agents
 → Tests
 → Verification gates
```

This creates a system that is fundamentally different from an AI editor whose primary abstraction is a conversation with an agent.

---

# 21. Strategic Priorities

### Tier 1 — Foundation

- Theia application
- Multi-project model
- Multi-repository model
- Worktrees
- Terminals
- Git
- Ranex Kernel integration
- Agent adapter interface

### Tier 2 — Core Ranex

- Multi-provider routing
- Agent orchestration
- Agent roles
- Parallel workers
- Evidence
- Verification
- Verdicts
- Task model
- Kanban

### Tier 3 — Differentiation

- Visual workflow designer
- Executable workflows
- Visual architecture
- Architecture/code linking
- Cross-project impact analysis
- Agent observability
- Replay
- Engineering memory

### Tier 4 — Advanced moat

- Automatic model routing
- Cost/quality optimization
- Architecture-aware orchestration
- Cross-project reasoning
- Historical engineering intelligence
- Evidence-backed architectural decisions
- Organizational engineering memory

---

# 22. Final Product Thesis

The market is moving toward autonomous coding agents.

The opportunity for Ranex is not simply to create another interface for those agents.

The opportunity is to create the **system that manages them**.

```text
Cursor     → AI coding environment
Devin      → Autonomous software agents
OpenCode   → Agent runtime
Theia      → IDE platform

Ranex      → Engineering control plane
             for autonomous software development
```

The product should make the following statement credible:

> **"Use any model. Use any agent. Work across any number of projects. Design how the agents work. See what they changed. Understand how the change affects the architecture. Verify the result independently. Keep the evidence."**

That is the strategic direction for Ranex.
