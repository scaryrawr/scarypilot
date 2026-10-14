#define OWNERSHIP_CORE_ONLY 1
#include "../shared/owned_job.h"
#include <array>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace {

constexpr size_t kChunk = 65536;
struct Runtime;
struct ChannelCensus final {
  DWORD phase = 0;
  DWORD code = 0;
  bool done = false;
  bool parentOpen = false;
  bool queued = false;
};
struct Census final {
  std::array<ChannelCensus, 3> channels{};
  bool childEndsClosed = false;
  bool jobEmptyConfirmed = false;
};
struct Delivery final {
  size_t channel = 3;
  bool started = false;
  std::vector<unsigned char> bytes;
  bool eof = false;
  bool terminal = false;
  bool killed = false;
  bool hasExit = false;
  DWORD exit = 0;
  const char* stage = nullptr;
  DWORD code = 0;
  const char* cleanupStage = nullptr;
  DWORD cleanupCode = 0;
  Census beforeDrain;
  Census afterCleanup;
};
struct Request final {
  bool pending = false;
  bool end = false;
  std::vector<unsigned char> bytes;
};
struct Pipe final {
  Handle parent;
  Handle child;
};

struct Runtime final {
  Launch launch;
  bool input = false;
  std::wstring searchPath;
  Run core;
  std::unique_ptr<Delivery> terminal = std::make_unique<Delivery>();
  std::array<Pipe, 3> pipes;
  std::array<Request, 3> requests;
  std::array<bool, 3> credits{};
  napi_threadsafe_function callback = nullptr;
  std::thread worker;
  std::array<std::thread, 3> io;
  std::array<std::atomic<bool>, 3> done{};
  std::array<std::atomic<DWORD>, 3> phases{};
  std::array<std::atomic<DWORD>, 3> ioCodes{};
  std::array<std::atomic<bool>, 3> parentOpen{};
  bool childEndsClosed = false;
  std::mutex mutex;
  std::condition_variable changed;
  std::atomic<bool> cancelled{false};
  std::atomic<bool> stopping{false};
  std::atomic<bool> discard{false};
  std::atomic<bool> ioStop{false};
  std::atomic<bool> closingEnv{false};
  std::atomic<bool> settled{false};
  Handle wake{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  const char* failureStage = nullptr;
  DWORD failureCode = 0;
  const char* cleanupStage = nullptr;
  DWORD cleanupCode = 0;
  bool terminalDelivered = false;
  bool hookRegistered = false;

  void Cancel(bool drop, bool user) {
    {
      std::lock_guard lock(mutex);
      stopping = true;
      if (user) cancelled = true;
      if (drop) discard = true;
    }
    SetEvent(wake.get());
    changed.notify_all();
  }

  void Fail(const char* stage, DWORD code, bool cleanup = false) {
    {
      std::lock_guard lock(mutex);
      if (!failureStage) { failureStage = stage; failureCode = code; }
      if (cleanup && !cleanupStage) { cleanupStage = stage; cleanupCode = code; }
      stopping = true;
      discard = true;
    }
    SetEvent(wake.get());
    changed.notify_all();
  }

  bool Post(std::unique_ptr<Delivery> delivery) {
    if (closingEnv) return true;
    const napi_status status = napi_call_threadsafe_function(callback, delivery.get(), napi_tsfn_nonblocking);
    if (status == napi_ok) delivery.release();
    else if (status == napi_closing) { Cancel(true, false); return false; }
    else Fail("CompletionDelivery", ERROR_NOT_ENOUGH_MEMORY);
    return true;
  }

  void PreparePipes() {
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    for (size_t channel = 0; channel < 3; ++channel) {
      if (channel == 0 && !input) {
        pipes[0].child.reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                       &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
        Win(static_cast<bool>(pipes[0].child), "CreateNulInput");
        done[0] = true;
        continue;
      }
      HANDLE reader = nullptr;
      HANDLE writer = nullptr;
      Win(CreatePipe(&reader, &writer, &security, static_cast<DWORD>(kChunk)) != FALSE, "CreatePrivatePipe");
      pipes[channel].parent.reset(channel == 0 ? writer : reader);
      parentOpen[channel] = true;
      pipes[channel].child.reset(channel == 0 ? reader : writer);
      Win(SetHandleInformation(pipes[channel].parent.get(), HANDLE_FLAG_INHERIT, 0) != FALSE,
          "ParentPipeMustNotBeInherited");
    }
  }

  void Io(size_t channel) noexcept {
    bool active = true;
    try {
      for (;;) {
        Request request;
        {
          std::unique_lock lock(mutex);
          phases[channel] = 1;
          changed.wait(lock, [&] { return ioStop || requests[channel].pending; });
          if (ioStop) {
            const bool abandoned = channel == 0 && requests[0].pending &&
                !requests[0].end && !requests[0].bytes.empty() && !cancelled && !discard;
            lock.unlock();
            if (abandoned) {
              ioCodes[0] = ERROR_BROKEN_PIPE;
              Fail("WriteInput", ERROR_BROKEN_PIPE);
            }
            break;
          }
          request = std::move(requests[channel]);
          requests[channel] = Request{};
          phases[channel] = channel == 0 ? (request.end ? 4UL : 3UL) : 2UL;
        }
        auto result = std::make_unique<Delivery>();
        result->channel = channel;
        if (channel == 0) {
          if (request.end) {
            pipes[0].parent.reset();
            parentOpen[0] = false;
            active = Post(std::move(result));
            break;
          }
          size_t offset = 0;
          while (offset < request.bytes.size()) {
            DWORD written = 0;
            Win(WriteFile(pipes[0].parent.get(), request.bytes.data() + offset,
                          static_cast<DWORD>(request.bytes.size() - offset), &written, nullptr) != FALSE,
                "WriteInput");
            Require(written != 0, "ShortInputWrite", ERROR_WRITE_FAULT);
            offset += written;
          }
        } else {
          result->bytes.resize(kChunk);
          DWORD bytes = 0;
          const BOOL read = ReadFile(pipes[channel].parent.get(), result->bytes.data(),
                                    static_cast<DWORD>(kChunk), &bytes, nullptr);
          if (!read) {
            const DWORD code = GetLastError();
            ioCodes[channel] = code;
            Require(code == ERROR_BROKEN_PIPE || code == ERROR_PIPE_NOT_CONNECTED ||
                        (ioStop && code == ERROR_OPERATION_ABORTED), "ReadOutput", code);
          }
          result->bytes.resize(bytes);
          result->eof = bytes == 0;
        }
        const bool eof = result->eof;
        active = Post(std::move(result));
        if (!active || eof) break;
      }
    } catch (const Failure& error) {
      ioCodes[channel] = error.code;
      if (channel == 0 ? (!cancelled && !discard) : !ioStop) Fail(error.stage, error.code);
    } catch (...) {
      Fail("NativeIoException", ERROR_NOT_ENOUGH_MEMORY);
    }
    pipes[channel].parent.reset();
    parentOpen[channel] = false;
    phases[channel] = 5;
    done[channel] = true;
    changed.notify_all();
    if (active) napi_release_threadsafe_function(callback, napi_tsfn_release);
  }

  Census Capture(bool jobEmptyConfirmed) {
    Census census;
    std::lock_guard lock(mutex);
    census.jobEmptyConfirmed = jobEmptyConfirmed;
    census.childEndsClosed = childEndsClosed;
    for (size_t channel = 0; channel < 3; ++channel) {
      census.channels[channel] = ChannelCensus{
        phases[channel].load(), ioCodes[channel].load(), done[channel].load(),
        parentOpen[channel].load(), requests[channel].pending,
      };
    }
    return census;
  }

  void CloseIo() {
    ioStop = true;
    changed.notify_all();
    for (auto& thread : io) {
      if (thread.joinable()) {
        if (!CancelSynchronousIo(thread.native_handle())) {
          const DWORD code = GetLastError();
          if (code != ERROR_NOT_FOUND) Fail("CancelNativeIo", code, true);
        }
      }
    }
  }

  void Work(const std::shared_ptr<Runtime>& owner) noexcept {
    auto result = std::move(terminal);
    bool active = true;
    result->terminal = true;
    try {
      if (!stopping && !launch.cancelled) {
        if (launch.executable == L"bash") {
          Require(!searchPath.empty(), "BashRequired", ERROR_FILE_NOT_FOUND);
          std::vector<wchar_t> executable(32768);
          const DWORD length = SearchPathW(searchPath.c_str(), L"bash.exe", nullptr,
                                           static_cast<DWORD>(executable.size()), executable.data(), nullptr);
          const DWORD code = GetLastError();
          Require(length != 0 && length < executable.size(), "BashRequired", code);
          launch.executable.assign(executable.data(), length);
        }
        PreparePipes();
        HANDLE stdio[] = {pipes[0].child.get(), pipes[1].child.get(), pipes[2].child.get()};
        core.Create(std::move(launch), stdio, &stopping);
        for (auto& pipe : pipes) pipe.child.reset();
        childEndsClosed = true;
        if (core.process) {
          auto ready = std::make_unique<Delivery>();
          ready->started = true;
          ready->exit = core.rootPid;
          active = Post(std::move(ready));
          for (size_t channel = 0; channel < 3; ++channel) {
            if (!active || stopping) { done[channel] = true; continue; }
            if (channel == 0 && !input) continue;
            Check(napi_acquire_threadsafe_function(callback));
            try { io[channel] = std::thread([owner, channel] { owner->Io(channel); }); }
            catch (...) { napi_release_threadsafe_function(callback, napi_tsfn_release); throw; }
          }
          {
            std::lock_guard lock(mutex);
            if (!stopping && !failureStage) core.Resume();
          }
          HANDLE waits[] = {wake.get(), core.process.get()};
          const DWORD status = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
          Require(status == WAIT_OBJECT_0 || status == WAIT_OBJECT_0 + 1, "WaitOwnedExecution",
                  status == WAIT_FAILED ? GetLastError() : status);
          if (status == WAIT_OBJECT_0 + 1) {
            result->exit = core.WaitRoot(0);
            result->hasExit = true;
          }
        }
      }
    } catch (const Failure& error) {
      Fail(error.stage, error.code);
    } catch (...) {
      Fail("NativeExecutionException", ERROR_NOT_ENOUGH_MEMORY);
    }
    bool jobEmptyConfirmed = false;
    try { core.Stop(); jobEmptyConfirmed = true; }
    catch (const Failure& error) { Fail(error.stage, error.code, true); core.DisposeHandles(); }
    catch (...) { Fail("NativeStopException", ERROR_UNHANDLED_EXCEPTION, true); core.DisposeHandles(); }
    result->beforeDrain = Capture(jobEmptyConfirmed);
    if (core.process) {
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
      std::unique_lock lock(mutex);
      if (!discard && !changed.wait_until(lock, deadline, [&] {
            return discard || (done[1] && done[2]);
          })) {
        failureStage = "OutputDrainTimeout";
        failureCode = WAIT_TIMEOUT;
      }
    }
    for (auto& pipe : pipes) pipe.child.reset();
    childEndsClosed = true;
    CloseIo();
    bool ioClosed = false;
    {
      std::unique_lock lock(mutex);
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
      ioClosed = changed.wait_until(lock, deadline, [&] {
        for (size_t index = 0; index < io.size(); ++index) {
          if (io[index].joinable() && !done[index]) return false;
        }
        return true;
      });
      if (!ioClosed) {
        if (!failureStage) { failureStage = "NativeIoCleanupUnconfirmed"; failureCode = WAIT_TIMEOUT; }
        if (!cleanupStage) { cleanupStage = "NativeIoCleanupUnconfirmed"; cleanupCode = WAIT_TIMEOUT; }
      }
      result->stage = failureStage;
      result->code = failureCode;
      result->cleanupStage = cleanupStage;
      result->cleanupCode = cleanupCode;
    }
    result->killed = cancelled;
    const auto release = [&] {
      for (auto& thread : io) if (thread.joinable()) thread.join();
      for (auto& pipe : pipes) pipe.parent.reset();
      for (auto& open : parentOpen) open = false;
      core.DisposeHandles();
    };
    if (ioClosed) release();
    result->afterCleanup = Capture(jobEmptyConfirmed);
    settled = true;
    if (active) active = Post(std::move(result));
    // Retain live I/O memory until actual completion, even after a cleanup rejection.
    if (!ioClosed) release();
    if (active) napi_release_threadsafe_function(callback, napi_tsfn_release);
  }
};

using Owner = std::shared_ptr<Runtime>;

void EnvironmentClosing(void* data) {
  auto* state = static_cast<Runtime*>(data);
  state->closingEnv = true;
  state->Cancel(true, false);
}

napi_value ErrorValue(napi_env env, const Delivery& failure, DWORD pid) {
  napi_value error;
  napi_value message;
  const std::string text = std::string(failure.stage) + " failed (Win32 " +
      std::to_string(failure.code) + "). " +
      (pid ? "Owned experiment root PID " + std::to_string(pid) +
             " is diagnostic, not an ancestry recovery handle. Retain the error; restart the host if native cleanup remains unconfirmed."
           : "No experiment process was created.") +
      (failure.cleanupStage ? std::string(" Cleanup failed: ") + failure.cleanupStage +
          " (Win32 " + std::to_string(failure.cleanupCode) + ")." : "");
  Check(napi_create_string_utf8(env, text.c_str(), text.size(), &message));
  Check(napi_create_error(env, nullptr, message, &error));
  napi_value stage;
  Check(napi_create_string_utf8(env, failure.stage, NAPI_AUTO_LENGTH, &stage));
  Set(env, error, "stage", stage);
  Set(env, error, "win32Code", Numeric(env, failure.code));
  if (pid) Set(env, error, "pid", Numeric(env, pid));
  if (failure.cleanupStage) {
    Check(napi_create_string_utf8(env, failure.cleanupStage, NAPI_AUTO_LENGTH, &stage));
    Set(env, error, "cleanupStage", stage);
    Set(env, error, "cleanupWin32Code", Numeric(env, failure.cleanupCode));
  }
  return error;
}

void Kind(napi_env env, napi_value value, const char* kind) {
  napi_value text;
  Check(napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &text));
  Set(env, value, "kind", text);
}

napi_value CensusValue(napi_env env, const Census& census) {
  napi_value value;
  Check(napi_create_object(env, &value));
  SetBool(env, value, "jobEmptyConfirmed", census.jobEmptyConfirmed);
  SetBool(env, value, "childEndsClosed", census.childEndsClosed);
  constexpr const char* names[] = {"input", "stdout", "stderr"};
  constexpr const char* phases[] = {
    "not-started", "waiting-for-credit", "reading", "writing", "ending-input", "closed",
  };
  for (size_t channel = 0; channel < 3; ++channel) {
    const auto& entry = census.channels[channel];
    napi_value state;
    napi_value phase;
    Check(napi_create_object(env, &state));
    Check(napi_create_string_utf8(env, phases[entry.phase], NAPI_AUTO_LENGTH, &phase));
    Set(env, state, "phase", phase);
    Set(env, state, "lastWin32Code", Numeric(env, entry.code));
    SetBool(env, state, "done", entry.done);
    SetBool(env, state, "parentOpen", entry.parentOpen);
    SetBool(env, state, "queuedRequest", entry.queued);
    Set(env, value, names[channel], state);
  }
  return value;
}

void Deliver(napi_env env, napi_value callback, void* context, void* data) {
  std::unique_ptr<Delivery> result(static_cast<Delivery*>(data));
  if (!env) return;
  auto& state = **static_cast<Owner*>(context);
  Boundary(env, [&]() {
    napi_value value;
    Check(napi_create_object(env, &value));
    if (result->started) {
      Kind(env, value, "started");
      Set(env, value, "pid", Numeric(env, result->exit));
    } else if (result->terminal) {
      if (state.terminalDelivered) return value;
      state.terminalDelivered = true;
      state.credits.fill(false);
      napi_value census;
      Check(napi_create_object(env, &census));
      Set(env, census, "rootPid", Numeric(env, state.core.rootPid));
      Set(env, census, "beforeOutputDrain", CensusValue(env, result->beforeDrain));
      Set(env, census, "afterCleanup", CensusValue(env, result->afterCleanup));
      Set(env, value, "lifecycle", census);
      if (result->stage) {
        Kind(env, value, "failed");
        Set(env, value, "error", ErrorValue(env, *result, state.core.rootPid));
      } else {
        Kind(env, value, "closed");
        napi_value completion;
        Check(napi_create_object(env, &completion));
        napi_value exit;
        if (result->hasExit) exit = Numeric(env, result->exit);
        else Check(napi_get_null(env, &exit));
        Set(env, completion, "exitCode", exit);
        SetBool(env, completion, "killed", result->killed);
        Set(env, value, "result", completion);
      }
    } else if (!state.terminalDelivered && state.credits[result->channel]) {
      state.credits[result->channel] = false;
      Kind(env, value, "io");
      Set(env, value, "channel", Numeric(env, static_cast<double>(result->channel)));
      if (result->channel != 0) {
        napi_value bytes;
        if (result->eof) Check(napi_get_null(env, &bytes));
        else Check(napi_create_buffer_copy(env, result->bytes.size(), result->bytes.data(), nullptr, &bytes));
        Set(env, value, "data", bytes);
      }
    } else return value;
    napi_value receiver;
    napi_value returned;
    Check(napi_get_undefined(env, &receiver));
    Check(napi_call_function(env, receiver, callback, 1, &value, &returned));
    return returned;
  });
}

void ReleaseRuntime(napi_env env, void* data, void*) {
  std::unique_ptr<Owner> owner(static_cast<Owner*>(data));
  auto& state = **owner;
  if (state.worker.joinable()) state.worker.join();
  if (state.hookRegistered && !state.closingEnv) napi_remove_env_cleanup_hook(env, EnvironmentClosing, &state);
}

Runtime& RuntimeReceiver(napi_env env, napi_callback_info info, size_t* count, napi_value* args) {
  napi_value self;
  Check(napi_get_cb_info(env, info, count, args, &self, nullptr));
  void* data = nullptr;
  Check(napi_unwrap(env, self, &data));
  Require(data != nullptr, "RuntimeReceiver");
  return **static_cast<Owner*>(data);
}

napi_value Operation(napi_env env, Runtime& state, size_t channel, Request request) {
  std::lock_guard lock(state.mutex);
  Require(!state.terminalDelivered && !state.credits[channel], "OutstandingIoCredit");
  Require(!(channel == 0 && (state.ioStop || state.settled) && !request.end &&
            !request.bytes.empty() && !state.cancelled && !state.discard),
          "WriteInput", ERROR_BROKEN_PIPE);
  state.credits[channel] = true;
  if (!state.settled && !state.ioStop) {
    request.pending = true;
    state.requests[channel] = std::move(request);
    state.changed.notify_all();
  }
  napi_value value;
  Check(napi_get_undefined(env, &value));
  return value;
}

napi_value Read(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 1;
    napi_value args[1];
    auto& state = RuntimeReceiver(env, info, &count, args);
    Require(count == 1, "ReadArguments");
    return Operation(env, state, static_cast<size_t>(Number(env, args[0], 1, 2)), Request{});
  });
}

napi_value Write(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 1;
    napi_value args[1];
    auto& state = RuntimeReceiver(env, info, &count, args);
    Require(count == 1 && state.input, "WriteArguments");
    napi_typedarray_type type;
    size_t length = 0;
    void* bytes = nullptr;
    napi_value buffer;
    size_t offset = 0;
    Check(napi_get_typedarray_info(env, args[0], &type, &length, &bytes, &buffer, &offset));
    Require(type == napi_uint8_array && length <= kChunk, "BoundedInputChunk");
    Request request;
    const auto* start = static_cast<unsigned char*>(bytes);
    if (length) request.bytes.assign(start, start + length);
    return Operation(env, state, 0, std::move(request));
  });
}

napi_value End(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 0;
    auto& state = RuntimeReceiver(env, info, &count, nullptr);
    Require(state.input, "InputNotPiped");
    Request request;
    request.end = true;
    return Operation(env, state, 0, std::move(request));
  });
}

napi_value Cancel(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 0;
    auto& state = RuntimeReceiver(env, info, &count, nullptr);
    state.Cancel(false, true);
    napi_value value;
    Check(napi_get_undefined(env, &value));
    return value;
  });
}

napi_value Discard(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 0;
    auto& state = RuntimeReceiver(env, info, &count, nullptr);
    state.Cancel(true, false);
    napi_value value;
    Check(napi_get_undefined(env, &value));
    return value;
  });
}

void FinalizeRuntime(napi_env, void* data, void*) {
  std::unique_ptr<Owner> owner(static_cast<Owner*>(data));
  (*owner)->Cancel(true, false);
}

napi_value Begin(napi_env env, napi_callback_info info) {
  return Boundary(env, [&]() {
    size_t count = 2;
    napi_value args[2];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    napi_valuetype callbackType;
    Require(count == 2, "BeginArguments");
    Check(napi_typeof(env, args[1], &callbackType));
    Require(callbackType == napi_function, "NotificationCallback");
    auto state = std::make_shared<Runtime>();
    Win(static_cast<bool>(state->wake), "CreateCancellationEvent");
    state->launch = ParseLaunch(env, args[0], true);
    state->searchPath = String(env, Property(env, args[0], "path"));
    Check(napi_get_value_bool(env, Property(env, args[0], "input"), &state->input));
    state->cancelled = state->launch.cancelled;
    state->stopping = state->launch.cancelled;
    napi_value object;
    Check(napi_create_object(env, &object));
    const napi_property_descriptor methods[] = {
      {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"endInput", nullptr, End, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"discard", nullptr, Discard, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods));
    auto wrapped = std::make_unique<Owner>(state);
    Check(napi_wrap(env, object, wrapped.get(), FinalizeRuntime, nullptr, nullptr));
    wrapped.release();
    auto context = std::make_unique<Owner>(state);
    napi_value name;
    Check(napi_create_string_utf8(env, "owned Windows execution", NAPI_AUTO_LENGTH, &name));
    Check(napi_create_threadsafe_function(env, args[1], nullptr, name, 8, 1, context.get(),
                                         ReleaseRuntime, context.get(), Deliver, &state->callback));
    context.release();
    try {
      Check(napi_add_env_cleanup_hook(env, EnvironmentClosing, state.get()));
      state->hookRegistered = true;
      state->worker = std::thread([state] { state->Work(state); });
    } catch (...) {
      napi_release_threadsafe_function(state->callback, napi_tsfn_abort);
      throw;
    }
    return object;
  });
}

napi_value InitializeRuntime(napi_env env, napi_value exports) {
  return Boundary(env, [&]() {
    const napi_property_descriptor methods[] = {
      {"begin", nullptr, Begin, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"architecture", nullptr, Architecture, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
    Set(env, exports, "nodeApiVersion", Numeric(env, 8));
    Set(env, exports, "protocolVersion", Numeric(env, 2));
    return exports;
  });
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, InitializeRuntime)
