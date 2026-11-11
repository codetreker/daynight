package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode"

	configvalue "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/logging"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

var exit = os.Exit

func main() {
	exit(run(context.Background(), os.Args[1:], os.LookupEnv, os.Stderr))
}

type rootFlag struct {
	value string
	set   bool
}

func (r *rootFlag) String() string { return r.value }
func (r *rootFlag) Set(value string) error {
	if r.set {
		return errors.New("duplicate root")
	}
	r.value, r.set = value, true
	return nil
}

func parseCommand(args []string, lookup func(string) (string, bool)) (string, string, error) {
	command := "server"
	if len(args) > 0 && args[0] == "verify-storage" {
		command, args = "verify-storage", args[1:]
	}
	var root rootFlag
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.Var(&root, "root", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return command, "", &configvalue.ConfigurationError{Field: "command-line arguments", Rule: "are not supported"}
	}
	if !root.set {
		root.value, root.set = lookup("DAYNIGHT_ROOT")
		if !root.set {
			root.value = "/var/lib/daynight"
		}
	}
	if strings.TrimSpace(root.value) == "" || !filepath.IsAbs(root.value) || strings.IndexFunc(root.value, unicode.IsControl) >= 0 {
		return command, "", &configvalue.ConfigurationError{Field: "root", Rule: "must be a nonempty absolute path without control characters"}
	}
	return command, root.value, nil
}

func run(ctx context.Context, args []string, lookup func(string) (string, bool), stderr io.Writer) (code int) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		slog.New(slog.NewJSONHandler(stderr, nil)).ErrorContext(ctx, "run identity generation failed")
		return 1
	}
	command := "server"
	if len(args) > 0 && args[0] == "verify-storage" {
		command = "verify-storage"
	}
	bootstrap := slog.New(slog.NewJSONHandler(stderr, nil)).With("run_id", hex.EncodeToString(id[:]), "pid", os.Getpid(), "command", command)
	command, root, err := parseCommand(args, lookup)
	if err != nil {
		httpx.LogFailure(bootstrap, ctx, "configuration", "arguments", err)
		return 1
	}
	if command == "verify-storage" {
		return verifyStorageCommand(ctx, root, lookup, stderr, bootstrap)
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	output, err := logging.Open(root, stderr, cancel)
	if err != nil {
		logLoggingFailure(bootstrap, ctx, err)
		return 1
	}
	// An incomplete application drain retains the output lock until process exit.
	// Releasing it while a producer can still log would admit a second writer.
	producersStopped := true
	defer func() {
		if err := output.Err(); err != nil {
			logLoggingFailure(bootstrap, ctx, err)
			code = 1
		}
		if producersStopped {
			if err := output.Close(); err != nil {
				logLoggingFailure(bootstrap, ctx, err)
				code = 1
			}
			if output.Err() != nil {
				code = 1
			}
		}
	}()
	logger := slog.New(slog.NewJSONHandler(output, nil)).With("run_id", hex.EncodeToString(id[:]), "pid", os.Getpid(), "command", command)
	cfg, err := config.LoadServer(root, lookup)
	if err != nil {
		phase := "validate"
		var configErr *configvalue.ConfigurationError
		if errors.As(err, &configErr) && configErr.Phase != "" {
			phase = configErr.Phase
		}
		httpx.LogFailure(logger, ctx, "configuration", phase, err)
		return 1
	}
	logger.InfoContext(ctx, "configuration_loaded", "event", "configuration_loaded", "component", "configuration", "local_override_loaded", cfg.LocalOverrideLoaded)
	if output.Err() != nil {
		return 1
	}
	startup, cancelStartup := context.WithTimeout(ctx, cfg.Server.StartupTimeout)
	defer cancelStartup()
	app, err := service.OpenAppWithLogger(startup, cfg, logger)
	if err != nil {
		httpx.LogFailure(logger, ctx, "server", "startup", err)
		producersStopped = !errors.Is(err, service.ErrAppCleanupIncomplete)
		return 1
	}
	code, producersStopped = serveAppResult(ctx, startup, cancelStartup, cfg, app, logger)
	return code
}

func logLoggingFailure(logger *slog.Logger, ctx context.Context, err error) {
	if detail, ok := err.(*logging.Error); ok {
		logger.ErrorContext(ctx, "logging_failed", "event", "logging_failed", "type", "operation_error", "component", "logging", "phase", detail.Phase, "sink", detail.Sink, "resource", detail.Resource, "error_code", "logging_failed", "cause", detail.Cause)
		return
	}
	if multiple, ok := err.(interface{ Unwrap() []error }); ok {
		for _, cause := range multiple.Unwrap() {
			logLoggingFailure(logger, ctx, cause)
		}
	} else if cause := errors.Unwrap(err); cause != nil {
		logLoggingFailure(logger, ctx, cause)
	}
}

func serveApp(ctx, startup context.Context, cancelStartup context.CancelFunc, cfg config.Config, app *service.App, logger *slog.Logger) int {
	code, _ := serveAppResult(ctx, startup, cancelStartup, cfg, app, logger)
	return code
}

func serveAppResult(ctx, startup context.Context, cancelStartup context.CancelFunc, cfg config.Config, app *service.App, logger *slog.Logger) (int, bool) {
	handler, err := server.New(app, cfg, logger)
	if err == nil {
		var metrics []server.MetricsEndpoint
		if cfg.Monitoring.Metrics.MetricsListenAddress != "" {
			metrics = append(metrics, server.MetricsEndpoint{Address: cfg.Monitoring.Metrics.MetricsListenAddress, Registry: app.Metrics})
		}
		runtime, startErr := server.Start(startup, cfg.Server.ListenAddress, cfg.Server.StartupTimeout, cfg.Server.ShutdownTimeout, logger, handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close, metrics...)
		if startErr == nil {
			if startErr = app.Start(ctx); startErr != nil {
				cleanup, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
				defer cancel()
				closeErr := runtime.Close(cleanup)
				err = errors.Join(startErr, closeErr)
				httpx.LogFailure(logger, ctx, "server", "startup", err)
				return 1, runtime.TransportDrained() && app.ProducersStopped()
			}
			cancelStartup()
			if runErr := runtime.Run(ctx); runErr != nil {
				httpx.LogFailure(logger, ctx, "server", "shutdown", runErr)
				return 1, runtime.TransportDrained() && app.ProducersStopped()
			}
			return 0, true
		}
		err = startErr
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if handler != nil {
		handler.BeginShutdown()
		err = errors.Join(err, handler.Shutdown(cleanup))
	}
	closeErr := app.Close(cleanup)
	err = errors.Join(err, closeErr)
	httpx.LogFailure(logger, ctx, "server", "startup", err)
	return 1, app.ProducersStopped()
}
