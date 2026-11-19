"""Nanoodle on ASI Agentverse: an optional, inactive-by-default uAgent facade.

This package is a Python sidecar for nanoodle-mcp. It lets ASI:One /
Agentverse users ask for a Nanoodle workflow run in chat; the actual
workflow execution (and all payment settlement) stays in nanoodle-mcp's
existing HTTP endpoint and its existing Nano / NEAR / x402 rails.

Nothing in this package creates a wallet, registers an agent, or moves
money. See ../README.md and ../RUNBOOK.md.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
