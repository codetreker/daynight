# Agent Note: Observe Snapshot Cancellation After Query Start

Status: implemented

## Problem

A cancellation test that starts a short deadline before acquiring a database connection can expire during connection setup instead of interrupting its intended query. The resulting failure does not exercise transaction cleanup and depends on runner load.

## Decision

Snapshot cleanup tests observe the database query running on its connection before canceling the request context or waiting for its deadline. Deadline cases prepare the observer and operation connection or transaction before starting a short deadline. The tests retain the original checks for driver closure, transaction outcome, joined database failures and connection pool reuse.

## Alternatives

**Only increase the original deadline.** A larger fixed interval still includes pool acquisition and transaction start and does not establish that the query was interrupted.

## Consequences

The tests require a second database connection and a bounded observation wait. They exercise actual PostgreSQL cancellation and cleanup without treating a timeout before the operation as evidence about transaction behavior. If scheduling delays prevent observation before the deadline, the test fails instead of accepting an unobserved interruption.
