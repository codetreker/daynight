package api

import workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"

type WorkerProbe[T any] = workerprotocol.WorkerProbe[T]
type WorkerOS = workerprotocol.WorkerOS
type WorkerCPU = workerprotocol.WorkerCPU
type WorkerMemory = workerprotocol.WorkerMemory
type WorkerDisk = workerprotocol.WorkerDisk
type WorkerVersions = workerprotocol.WorkerVersions
type WorkerAssistantProvider = workerprotocol.WorkerAssistantProvider
type WorkerAssistantHost = workerprotocol.WorkerAssistantHost
type WorkerTelemetry = workerprotocol.WorkerTelemetry
type WorkerTaskReference = workerprotocol.WorkerTaskReference
type WorkerTaskInventory = workerprotocol.WorkerTaskInventory
type WorkerReport = workerprotocol.WorkerReport
type WorkerReportResponse = workerprotocol.WorkerReportResponse
type WorkerTaskSnapshot = workerprotocol.WorkerTaskSnapshot
type WorkerSummary = workerprotocol.WorkerSummary
type WorkerDetail = workerprotocol.WorkerDetail
type WorkerPage = workerprotocol.WorkerPage
type WorkerDetailResponse = workerprotocol.WorkerDetailResponse
