package server

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	monitoring "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type workerOperations interface {
	Report(context.Context, model.Principal, string, model.WorkerReport) (workerservice.WorkerReportResult, error)
	ReportSync(context.Context, model.Principal, string, model.WorkerReport, []model.PromptSelector) (workerservice.ConfigurationSyncResult, error)
	List(context.Context, model.Principal, model.PageRequest) (workerservice.WorkerPage, error)
	Get(context.Context, model.Principal, string) (workerservice.WorkerDetailResult, error)
	Configuration(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error)
	PutConfiguration(context.Context, model.Principal, string, string, model.WorkerConfiguration) (model.WorkerConfigurationResource, error)
	PutMonitoring(context.Context, model.Principal, string, *string, monitoring.Observation) (monitoring.Receipt, error)
	GetMonitoring(context.Context, model.Principal, string) (monitoring.DetailResponse, error)
	QueryMonitoring(context.Context, model.Principal, []string) (monitoring.QueryResponse, error)
}

type promptOperations interface {
	Get(context.Context, model.Principal, model.PromptScope, string) (model.PromptResource, error)
	Put(context.Context, model.Principal, model.PromptScope, string, string, string, string) (model.PromptResource, error)
}
