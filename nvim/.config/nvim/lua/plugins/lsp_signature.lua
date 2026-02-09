return {
	{
		"ray-x/lsp_signature.nvim",
		event = "BufRead",
		config = function()
			require("lsp_signature").setup({
				bind = true, -- This is mandatory, otherwise border config won't get registered.
				hint_enable = true,
				-- handler_opts = {
				--   border = "rounded"
				-- }
			})
		end,
	},
}
