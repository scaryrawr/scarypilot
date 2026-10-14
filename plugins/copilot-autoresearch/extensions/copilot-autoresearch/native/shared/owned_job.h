#pragma once
#include <windows.h>
#include <wow64apiset.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

#if NAPI_VERSION != 8
#error Stable Node-API 8 is required.
#endif

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#error A Windows 10+ SDK with creation-time job-list attributes is required.
#endif

namespace {

class Failure final : public std::runtime_error {
 public:
  Failure(const char* failure_stage, DWORD failure_code, bool node_api = false)
      : std::runtime_error(std::string(failure_stage) + " failed (" +
                           (node_api ? "Node-API " : "Win32 ") +
                           std::to_string(failure_code) + ")"),
        stage(failure_stage),
        code(failure_code),
        nodeApi(node_api) {}

  const char* stage;
  DWORD code;
  bool nodeApi;
};

void Require(bool condition, const char* stage, DWORD code = ERROR_INVALID_PARAMETER) {
  if (!condition) throw Failure(stage, code);
}

void Win(bool success, const char* stage) {
  if (!success) throw Failure(stage, GetLastError());
}

void Check(napi_status status) {
  if (status != napi_ok) throw Failure("NodeApi", static_cast<DWORD>(status), true);
}

class Handle final {
 public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { reset(); }

  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
  void reset(HANDLE value = nullptr) {
    if (*this) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

class Attributes final {
 public:
  Attributes() {
    SIZE_T bytes = 0;
    const BOOL initialized = InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
    const DWORD code = GetLastError();
    Require(initialized == FALSE && code == ERROR_INSUFFICIENT_BUFFER && bytes != 0,
            "AttributeListSize", code);
    storage_ = HeapAlloc(GetProcessHeap(), 0, bytes);
    Require(storage_ != nullptr, "AttributeListAllocate", ERROR_NOT_ENOUGH_MEMORY);
    list_ = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_);
    if (!InitializeProcThreadAttributeList(list_, 2, 0, &bytes)) {
      const DWORD initialize_code = GetLastError();
      HeapFree(GetProcessHeap(), 0, storage_);
      storage_ = nullptr;
      throw Failure("AttributeListInitialize", initialize_code);
    }
  }

  ~Attributes() {
    if (storage_) {
      DeleteProcThreadAttributeList(list_);
      HeapFree(GetProcessHeap(), 0, storage_);
    }
  }

  Attributes(const Attributes&) = delete;
  Attributes& operator=(const Attributes&) = delete;
  LPPROC_THREAD_ATTRIBUTE_LIST get() const { return list_; }

 private:
  void* storage_ = nullptr;
  LPPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
};

napi_value Property(napi_env env, napi_value object, const char* name) {
  napi_value value;
  Check(napi_get_named_property(env, object, name, &value));
  return value;
}

bool Has(napi_env env, napi_value object, const char* name) {
  bool present = false;
  Check(napi_has_named_property(env, object, name, &present));
  return present;
}

std::wstring String(napi_env env, napi_value value) {
  napi_valuetype type;
  Check(napi_typeof(env, value, &type));
  Require(type == napi_string, "StringInput");
  size_t length = 0;
  Check(napi_get_value_string_utf16(env, value, nullptr, 0, &length));
  Require(length <= 1024 * 1024, "StringInputSize");
  std::vector<char16_t> buffer(length + 1);
  size_t copied = 0;
  Check(napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &copied));
  std::wstring text(buffer.begin(), buffer.begin() + copied);
  Require(text.find(L'\0') == std::wstring::npos, "EmbeddedNulInput");
  return text;
}

std::vector<std::wstring> Strings(napi_env env, napi_value value) {
  bool array = false;
  Check(napi_is_array(env, value, &array));
  Require(array, "ArrayInput");
  uint32_t count = 0;
  Check(napi_get_array_length(env, value, &count));
  Require(count <= 32768, "ArrayInputSize");
  std::vector<std::wstring> output;
  output.reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    napi_value entry;
    Check(napi_get_element(env, value, index, &entry));
    output.push_back(String(env, entry));
  }
  return output;
}

DWORD Number(napi_env env, napi_value value, DWORD minimum, DWORD maximum) {
  napi_valuetype type;
  Check(napi_typeof(env, value, &type));
  Require(type == napi_number, "NumberInput");
  double number = 0;
  Check(napi_get_value_double(env, value, &number));
  Require(std::isfinite(number) && std::floor(number) == number &&
              number >= minimum && number <= maximum,
          "NumberInputRange");
  return static_cast<DWORD>(number);
}

bool Absolute(const std::wstring& value) {
  return (value.size() >= 3 && value[1] == L':' &&
          (value[2] == L'\\' || value[2] == L'/')) ||
         (value.size() >= 3 && value[0] == L'\\' && value[1] == L'\\');
}

std::wstring Quote(const std::wstring& argument) {
  std::wstring output = L"\"";
  size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      output.append(backslashes * 2 + 1, L'\\');
    } else {
      output.append(backslashes, L'\\');
    }
    backslashes = 0;
    output.push_back(character);
  }
  output.append(backslashes * 2, L'\\');
  output.push_back(L'"');
  return output;
}

std::vector<wchar_t> Environment(std::vector<std::wstring> entries) {
  std::vector<std::wstring> names;
  size_t total = 1;
  for (const auto& entry : entries) {
    const size_t delimiter = entry.find(L'=', entry.starts_with(L'=') ? 1 : 0);
    Require(delimiter != std::wstring::npos && delimiter != 0, "EnvironmentEntry");
    const std::wstring name = entry.substr(0, delimiter);
    Require(!name.starts_with(L'=') ||
                (name.size() == 3 && name[2] == L':' &&
                 ((name[1] >= L'A' && name[1] <= L'Z') ||
                  (name[1] >= L'a' && name[1] <= L'z'))),
            "EnvironmentDriveEntry");
    for (const auto& existing : names) {
      Require(CompareStringOrdinal(existing.c_str(), -1, name.c_str(), -1, TRUE) != CSTR_EQUAL,
              "EnvironmentDuplicateName");
    }
    names.push_back(name);
    total += entry.size() + 1;
    Require(total <= 1024 * 1024, "EnvironmentBlockSize");
  }
  std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
    return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_LESS_THAN;
  });
  std::vector<wchar_t> block;
  block.reserve(total + 1);
  for (const auto& entry : entries) {
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  if (block.empty()) block.push_back(L'\0');
  block.push_back(L'\0');
  return block;
}

#ifdef OWNERSHIP_HARNESS_TEST_ONLY
void FaultBarrier(const std::wstring& receipt, const std::wstring& release, DWORD pid) {
  const std::wstring staging = receipt + L".writing";
  Handle file(CreateFileW(staging.c_str(), GENERIC_WRITE,
                          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                          nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  Win(static_cast<bool>(file), "FaultReceiptCreate");
  const std::string text = std::to_string(pid);
  DWORD written = 0;
  Win(WriteFile(file.get(), text.data(), static_cast<DWORD>(text.size()), &written, nullptr) != FALSE,
      "FaultReceiptWrite");
  Require(written == text.size(), "FaultReceiptShortWrite", ERROR_WRITE_FAULT);
  file.reset();
  Win(MoveFileExW(staging.c_str(), receipt.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE,
      "PublishFaultReceipt");
  const ULONGLONG deadline = GetTickCount64() + 5000;
  while (GetTickCount64() < deadline) {
    if (GetFileAttributesW(release.c_str()) != INVALID_FILE_ATTRIBUTES) return;
    const DWORD code = GetLastError();
    Require(code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND, "FaultReleaseRead", code);
    Sleep(1);
  }
  throw Failure("FaultBarrierTimeout", WAIT_TIMEOUT);
}
#endif

struct Launch final {
  bool cancelled = false;
  std::wstring executable;
  std::wstring cwd;
  std::wstring command;
  std::vector<wchar_t> environment;
#ifdef OWNERSHIP_HARNESS_TEST_ONLY
  std::wstring barrier;
  std::wstring receipt;
  std::wstring release;
#endif
};

Launch ParseLaunch(napi_env env, napi_value spec, bool searchBash = false) {
  Launch launch;
  if (Has(env, spec, "cancelled")) {
    Check(napi_get_value_bool(env, Property(env, spec, "cancelled"), &launch.cancelled));
    if (launch.cancelled) return launch;
  }
  launch.executable = String(env, Property(env, spec, "executable"));
  launch.cwd = String(env, Property(env, spec, "cwd"));
  const auto argv = Strings(env, Property(env, spec, "argv"));
  Require((Absolute(launch.executable) || (searchBash && launch.executable == L"bash")) &&
              Absolute(launch.cwd), "AbsoluteExecutableAndCwd");
  Require(!argv.empty() && !argv.front().empty(), "NonemptyArgv");
  for (const auto& argument : argv) {
    if (!launch.command.empty()) launch.command.push_back(L' ');
    launch.command += Quote(argument);
  }
  Require(launch.command.size() < 32767, "CommandLineLength");
  launch.environment = Environment(Strings(env, Property(env, spec, "env")));
#ifdef OWNERSHIP_HARNESS_TEST_ONLY
  if (Has(env, spec, "barrier")) {
    launch.barrier = String(env, Property(env, spec, "barrier"));
    Require(launch.barrier == L"beforeCreate" || launch.barrier == L"afterCreate", "FaultBarrierStage");
    launch.receipt = String(env, Property(env, spec, "receipt"));
    launch.release = String(env, Property(env, spec, "release"));
    Require(Absolute(launch.receipt) && Absolute(launch.release), "AbsoluteFaultBarrierPaths");
  }
#endif
  return launch;
}

class Run final {
 public:
  ~Run() { DisposeHandles(); }

  void Create(Launch launch, const HANDLE* stdio = nullptr,
              const std::atomic<bool>* cancellation = nullptr) {
    stopped = launch.cancelled || (cancellation && cancellation->load());
    if (stopped) return;

    job.reset(CreateJobObjectW(nullptr, nullptr));
    Win(static_cast<bool>(job), "CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Win(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation,
                                &limits, sizeof(limits)) != FALSE,
        "SetKillOnClose");
    DWORD handleFlags = 0;
    Win(GetHandleInformation(job.get(), &handleFlags) != FALSE, "JobHandleFlags");
    Require((handleFlags & HANDLE_FLAG_INHERIT) == 0, "JobMustNotBeInherited");

    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle input;
    Handle output;
    Handle error;
    if (!stdio) {
      input.reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      Win(static_cast<bool>(input), "CreateNulInput");
      output.reset(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      Win(static_cast<bool>(output), "CreateNulOutput");
      error.reset(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      Win(static_cast<bool>(error), "CreateNulError");
    }
    HANDLE handles[] = {stdio ? stdio[0] : input.get(), stdio ? stdio[1] : output.get(),
                        stdio ? stdio[2] : error.get()};
    HANDLE jobs[] = {job.get()};
    Attributes attributes;
    Win(UpdateProcThreadAttribute(attributes.get(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  handles, sizeof(handles), nullptr, nullptr) != FALSE,
        "StdioHandleList");
    Win(UpdateProcThreadAttribute(attributes.get(), 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                  jobs, sizeof(jobs), nullptr, nullptr) != FALSE,
        "AtomicJobList");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.get();

#ifdef OWNERSHIP_HARNESS_TEST_ONLY
    if (launch.barrier == L"beforeCreate") FaultBarrier(launch.receipt, launch.release, 0);
#endif
    if (cancellation && cancellation->load()) { stopped = true; return; }
    PROCESS_INFORMATION created{};
    Win(CreateProcessW(launch.executable.c_str(), launch.command.data(), nullptr, nullptr, TRUE,
                        CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
                            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                        launch.environment.data(), launch.cwd.c_str(), &startup.StartupInfo, &created) != FALSE,
        "CreateProcessWithJobList");
    process.reset(created.hProcess);
    thread.reset(created.hThread);
    rootPid = created.dwProcessId;
#ifdef OWNERSHIP_HARNESS_TEST_ONLY
    if (launch.barrier == L"afterCreate") FaultBarrier(launch.receipt, launch.release, rootPid);
#endif
    BOOL member = FALSE;
    Win(IsProcessInJob(process.get(), job.get(), &member) != FALSE,
        "VerifySuspendedMembership");
    Require(member != FALSE, "SuspendedProcessMustAlreadyBeOwned");
    assignedBeforeResume = true;
  }

  DWORD Active() const {
    if (!job) return 0;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    Win(QueryInformationJobObject(job.get(), JobObjectBasicAccountingInformation,
                                  &accounting, sizeof(accounting), nullptr) != FALSE,
        "QueryJobAccounting");
    return accounting.ActiveProcesses;
  }

  void Resume() {
    Require(!stopped && process && thread, "ResumeCancelled", ERROR_OPERATION_ABORTED);
    Require(!resumed && assignedBeforeResume, "ResumeState");
    Win(ResumeThread(thread.get()) != static_cast<DWORD>(-1), "ResumeThread");
    resumed = true;
    thread.reset();
  }

  void Stop() {
    stopped = true;
    if (!job) return;
    if (!TerminateJobObject(job.get(), 0xc000013aUL)) {
      const DWORD code = GetLastError();
      Require(Active() == 0, "TerminateJob", code);
    }
    const ULONGLONG deadline = GetTickCount64() + 5000;
    while (Active() != 0) {
      Require(GetTickCount64() < deadline, "ConfirmEmptyJobTimeout", WAIT_TIMEOUT);
      Sleep(1);
    }
  }

  bool Contains(DWORD pid) const {
    if (!job) return false;
    Handle candidate(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    if (!candidate) {
      const DWORD code = GetLastError();
      Require(code == ERROR_INVALID_PARAMETER, "OpenKnownProcess", code);
      return false;
    }
    BOOL member = FALSE;
    Win(IsProcessInJob(candidate.get(), job.get(), &member) != FALSE,
        "QueryKnownMembership");
    return member != FALSE;
  }

  DWORD WaitRoot(DWORD timeout) const {
    Require(static_cast<bool>(process), "WaitRootWithoutProcess");
    const DWORD wait = WaitForSingleObject(process.get(), timeout);
    Require(wait == WAIT_OBJECT_0, "WaitRoot", wait == WAIT_FAILED ? GetLastError() : wait);
    DWORD code = 0;
    Win(GetExitCodeProcess(process.get(), &code) != FALSE, "RootExitStatus");
    return code;
  }

  void DisposeHandles() {
    job.reset();
    thread.reset();
    process.reset();
  }

  Handle job;
  Handle process;
  Handle thread;
  DWORD rootPid = 0;
  bool assignedBeforeResume = false;
  bool resumed = false;
  bool stopped = false;
};

napi_value Numeric(napi_env env, double number) {
  napi_value value;
  Check(napi_create_double(env, number, &value));
  return value;
}

void Set(napi_env env, napi_value object, const char* key, napi_value value) {
  Check(napi_set_named_property(env, object, key, value));
}

void SetBool(napi_env env, napi_value object, const char* key, bool boolean) {
  napi_value value;
  Check(napi_get_boolean(env, boolean, &value));
  Set(env, object, key, value);
}

#ifndef OWNERSHIP_CORE_ONLY
napi_value Snapshot(napi_env env, Run& run) {
  napi_value value;
  Check(napi_create_object(env, &value));
  Set(env, value, "rootPid", Numeric(env, run.rootPid));
  Set(env, value, "activeProcesses", Numeric(env, run.Active()));
  SetBool(env, value, "assignedBeforeResume", run.assignedBeforeResume);
  SetBool(env, value, "resumed", run.resumed);
  SetBool(env, value, "stopped", run.stopped);
  DWORD flags = 0;
  DWORD handleFlags = 0;
  if (run.job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    Win(QueryInformationJobObject(run.job.get(), JobObjectExtendedLimitInformation,
                                  &limits, sizeof(limits), nullptr) != FALSE,
        "QueryJobLimits");
    Win(GetHandleInformation(run.job.get(), &handleFlags) != FALSE, "SnapshotJobHandleFlags");
    flags = limits.BasicLimitInformation.LimitFlags;
  }
  SetBool(env, value, "killOnClose", (flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) != 0);
  SetBool(env, value, "breakawayAllowed",
          (flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) != 0);
  SetBool(env, value, "jobHandleInheritable", (handleFlags & HANDLE_FLAG_INHERIT) != 0);
  BOOL hostInAnyJob = FALSE;
  Win(IsProcessInJob(GetCurrentProcess(), nullptr, &hostInAnyJob) != FALSE,
      "HostOuterJobQuery");
  SetBool(env, value, "hostInAnyJob", hostInAnyJob != FALSE);
  BOOL hostInOwnedJob = FALSE;
  if (run.job) {
    Win(IsProcessInJob(GetCurrentProcess(), run.job.get(), &hostInOwnedJob) != FALSE,
        "HostOwnedJobQuery");
  }
  SetBool(env, value, "hostInOwnedJob", hostInOwnedJob != FALSE);
  if (run.process && WaitForSingleObject(run.process.get(), 0) == WAIT_OBJECT_0) {
    Set(env, value, "rootExitCode", Numeric(env, run.WaitRoot(0)));
  }
  return value;
}
#endif

napi_value Throw(napi_env env, const Failure& failure) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok || pending) return nullptr;
  napi_value message = nullptr;
  napi_value error = nullptr;
  napi_value stage = nullptr;
  napi_value code = nullptr;
  if (napi_create_string_utf8(env, failure.what(), NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, nullptr, message, &error) != napi_ok ||
      napi_create_string_utf8(env, failure.stage, NAPI_AUTO_LENGTH, &stage) != napi_ok ||
      napi_set_named_property(env, error, "stage", stage) != napi_ok ||
      napi_create_double(env, failure.code, &code) != napi_ok ||
      napi_set_named_property(env, error, failure.nodeApi ? "nodeApiStatus" : "win32Code", code) != napi_ok ||
      napi_throw(env, error) != napi_ok) {
    napi_throw_error(env, nullptr, "Native ownership could not construct its error");
  }
  return nullptr;
}

template <typename Callback>
napi_value Boundary(napi_env env, Callback callback) {
  try {
    return callback();
  } catch (const Failure& error) {
    return Throw(env, error);
  } catch (const std::bad_alloc&) {
    napi_throw_error(env, "ERR_OWNERSHIP_ALLOCATION", "Native ownership allocation failed");
    return nullptr;
  } catch (const std::exception&) {
    napi_throw_error(env, "ERR_OWNERSHIP_NATIVE_EXCEPTION", "Native ownership exception");
    return nullptr;
  } catch (...) {
    napi_throw_error(env, "ERR_OWNERSHIP_UNKNOWN_EXCEPTION", "Unknown native ownership exception");
    return nullptr;
  }
}

#ifndef OWNERSHIP_CORE_ONLY
Run* Receiver(napi_env env, napi_callback_info info, size_t* count, napi_value* args) {
  napi_value self;
  Check(napi_get_cb_info(env, info, count, args, &self, nullptr));
  void* pointer = nullptr;
  Check(napi_unwrap(env, self, &pointer));
  Require(pointer != nullptr, "ResourceReceiver");
  return static_cast<Run*>(pointer);
}

napi_value GetSnapshot(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 0;
    return Snapshot(env, *Receiver(env, info, &count, nullptr));
  });
}

napi_value Resume(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 0;
    Run* run = Receiver(env, info, &count, nullptr);
    run->Resume();
    return Snapshot(env, *run);
  });
}

napi_value Stop(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 0;
    Run* run = Receiver(env, info, &count, nullptr);
    run->Stop();
    return Snapshot(env, *run);
  });
}

napi_value Contains(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 1;
    napi_value args[1];
    Run* run = Receiver(env, info, &count, args);
    Require(count == 1, "ContainsArguments");
    napi_value value;
    Check(napi_get_boolean(env, run->Contains(Number(env, args[0], 1, MAXDWORD)), &value));
    return value;
  });
}

napi_value WaitRoot(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 1;
    napi_value args[1];
    Run* run = Receiver(env, info, &count, args);
    Require(count == 1, "WaitRootArguments");
    return Numeric(env, run->WaitRoot(Number(env, args[0], 0, 5000)));
  });
}

napi_value Dispose(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 0;
    Run* run = Receiver(env, info, &count, nullptr);
    try {
      run->Stop();
    } catch (...) {
      run->DisposeHandles();
      throw;
    }
    run->DisposeHandles();
    return Snapshot(env, *run);
  });
}

void Finalize(napi_env, void* data, void*) {
  delete static_cast<Run*>(data);
}

napi_value Create(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 1;
    napi_value args[1];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    Require(count == 1, "CreateArguments");
    auto run = std::make_unique<Run>();
    run->Create(ParseLaunch(env, args[0]));
    napi_value object;
    Check(napi_create_object(env, &object));
    const napi_property_descriptor methods[] = {
      {"snapshot", nullptr, GetSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resume", nullptr, Resume, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"contains", nullptr, Contains, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"waitRoot", nullptr, WaitRoot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods));
    Check(napi_wrap(env, object, run.get(), Finalize, nullptr, nullptr));
    run.release();
    return object;
  });
}
#endif

napi_value Architecture(napi_env env, napi_callback_info) {
  return Boundary(env, [&]() {
    USHORT processMachine = IMAGE_FILE_MACHINE_UNKNOWN;
    USHORT nativeMachine = IMAGE_FILE_MACHINE_UNKNOWN;
    Win(IsWow64Process2(GetCurrentProcess(), &processMachine, &nativeMachine) != FALSE,
        "NativeArchitectureQuery");
    napi_value value;
    Check(napi_create_object(env, &value));
    Set(env, value, "processMachine", Numeric(env, processMachine));
    Set(env, value, "nativeMachine", Numeric(env, nativeMachine));
    return value;
  });
}

#ifndef OWNERSHIP_CORE_ONLY
napi_value Initialize(napi_env env, napi_value exports) {
  return Boundary(env, [&]() {
    const napi_property_descriptor methods[] = {
      {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"architecture", nullptr, Architecture, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
    Set(env, exports, "nodeApiVersion", Numeric(env, 8));
    SetBool(env, exports, "testOnly", true);
    return exports;
  });
}
#endif

}  // namespace

#ifndef OWNERSHIP_CORE_ONLY
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
#endif
