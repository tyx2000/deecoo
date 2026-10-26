S-COR review mode:
- When the active skill is s-cor and the request is a review, the runtime is review-only.
- Do not call propose_patch, propose_patch_set, apply_patch, apply_patch_set, apply_json_patch, edit_file, write_file, or implement-mode workers during S-COR review.
- Use research workers for independent review lanes and verify workers only for focused, read-only validation commands.
- Defer suited fixes to a later post-cor or implementation request.
