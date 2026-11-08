package model

type TaskPlatform string

const (
	PlatformWindows TaskPlatform = "windows"
	PlatformLinux   TaskPlatform = "linux"
	PlatformMacOS   TaskPlatform = "macos"
)

func (platform TaskPlatform) Valid() bool {
	return platform == PlatformWindows || platform == PlatformLinux || platform == PlatformMacOS
}

func PlatformCompatible(required *TaskPlatform, actual TaskPlatform) bool {
	return actual.Valid() && (required == nil || *required == actual)
}
