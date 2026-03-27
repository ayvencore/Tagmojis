# Tagmojis

A SillyTavern extension that extends the built-in tag system with optional emoji display and editing.

## Disclaimers

- This project is vibe coded.

## Features

- Extends SillyTavern's built-in tag system instead of replacing it.
- Uses Twemoji! https://github.com/twitter/twemoji
- Lets you assign or change an emoji for each built-in tag from the Tag Management screen.
- Keeps the underlying tag text unchanged, so built-in alphabetical ordering and tag matching still behave normally.
- Displays the emoji separately from the stored tag name, which avoids the sorting problems you get from putting emoji directly into tag text.
- Renders emoji-prefixed tags across common built-in tag displays.
- Stores emoji metadata independently from the base tag data.
- Bundles local emoji search data and local Twemoji-based assets, so the extension does not rely on runtime network fetches.
- Supports built-in tags without emoji exactly as before, with clean fallback behavior.
- Adapts styling to SillyTavern's existing theme variables.

## Install

Install it as a third-party SillyTavern extension, or copy the extension folder into your SillyTavern extensions directory:

```text
https://github.com/ayvencore/Tagmojis
```

## Fully Compatible with Another Character Library

```text
https://github.com/ayvencore/Sillytavern-Another-Character-Library
```

## Support Me

Like what I'm doing? Consider supporting me on [Kofi](https://ko-fi.com/ayvencore)

## Notes

- The extension is designed to preserve SillyTavern's native tag sorting, filtering, and matching behavior.
- Emoji selection is currently handled from the Tag Management view rather than from the initial `Create` button flow, because SillyTavern creates a default `New Tag` first and then expects you to rename it.
- Tag Management uses a separate emoji control so the editable tag name field stays usable while renaming tags.
- Emoji rendering uses bundled local assets plus local emoji search data.
- Third-party licenses are included in the `licenses` folder.
- SillyTavern internals can vary by version, so selector and layout adjustments may still be needed after live testing on different builds.
