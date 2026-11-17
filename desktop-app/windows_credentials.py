"""Local credential file encrypted by Windows DPAPI for the current user."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile


class DataBlob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def transform(value, *, protect):
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32')
    buf = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
    source = DataBlob(len(buf), buf)
    target = DataBlob()
    api = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
    api.argtypes = [ctypes.POINTER(DataBlob), wintypes.LPCWSTR if protect else ctypes.c_void_p,
                    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                    ctypes.POINTER(DataBlob)]
    api.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel.LocalFree.restype = wintypes.HLOCAL
    try:
        # UI forbidden, with no machine-wide flag. DPAPI uses the current Windows user.
        if not api(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.memset(buf, 0, len(buf))
        if target.data:
            if not protect:
                ctypes.memset(target.data, 0, target.size)
            kernel.LocalFree(target.data)


def save_credentials(path, username, password):
    plaintext = json.dumps({'username': username, 'password': password}).encode('utf-8')
    encrypted = transform(plaintext, protect=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temp_path = Path(temporary.name)
        try:
            temporary.write(encrypted)
            temporary.close()
            os.replace(temp_path, path)
        finally:
            temporary.close()
            temp_path.unlink(missing_ok=True)


if __name__ == '__main__':
    # The desktop's Node worker starts this helper with private stdout/stderr pipes.
    try:
        if len(sys.argv) != 2 or sys.stdout.isatty():
            sys.exit(2)
        sys.stdout.buffer.write(transform(Path(sys.argv[1]).read_bytes(), protect=False))
    except (OSError, ValueError):
        sys.exit(1)
