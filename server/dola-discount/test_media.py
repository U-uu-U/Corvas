import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import media

MP4 = b'\x00\x00\x00\x18ftypisom' + b'video-fixture' * 10


def response(body=MP4, content_type='video/mp4', length=None):
    value = io.BytesIO(body)
    value.headers = {'Content-Type': content_type, 'Content-Length': str(len(body) if length is None else length)}
    return value


class MediaTests(unittest.TestCase):
    def test_authenticated_content_is_saved_atomically_and_auth_dropped_on_redirect(self):
        redirect = urllib.error.HTTPError('http://upstream.test/v1/videos/task_1/content', 302, 'Found',
                                          {'Location': 'https://cdn.test/signed.mp4?sig=keep'}, io.BytesIO())
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(media.HTTP, 'open', side_effect=[redirect, response()]) as request, \
                patch.object(media, 'validate_redirect', side_effect=lambda value: value):
            target = Path(directory) / 'fixture.mp4'
            media.transfer('http://upstream.test', 'task_1', 'Bearer private', target)
            self.assertEqual(target.read_bytes(), MP4)
            self.assertFalse(target.with_suffix('.part').exists())
        first, second = [call.args[0] for call in request.call_args_list]
        self.assertEqual(first.full_url, 'http://upstream.test/v1/videos/task_1/content')
        self.assertEqual(first.get_header('Authorization'), 'Bearer private')
        self.assertIsNone(second.get_header('Authorization'))
        self.assertEqual(second.full_url, 'https://cdn.test/signed.mp4?sig=keep')

    def test_json_error_empty_or_truncated_media_never_becomes_a_public_mp4(self):
        for value in [response(b'{"error":"failed"}', 'application/json'), response(b''),
                      response(length=len(MP4) + 100), response(b'not-video-file')]:
            with tempfile.TemporaryDirectory() as directory, patch.object(media.HTTP, 'open', return_value=value):
                target = Path(directory) / 'fixture.mp4'
                with self.assertRaises(ValueError):
                    media.transfer('http://upstream.test', 'task_1', 'Bearer private', target)
                self.assertFalse(target.exists())
                self.assertFalse(target.with_suffix('.part').exists())

    def test_private_or_credentialed_redirects_are_rejected(self):
        for url in ['file:///etc/passwd', 'https://user:secret@cdn.test/a.mp4']:
            with self.assertRaises(ValueError):
                media.validate_redirect(url)
        with patch.object(media.socket, 'getaddrinfo', return_value=[(None, None, None, None, ('127.0.0.1', 443))]):
            with self.assertRaises(ValueError):
                media.validate_redirect('https://cdn.test/a.mp4')
