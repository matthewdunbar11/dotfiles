return {
	"stevearc/conform.nvim",
	event = { "BufReadPre", "BufNewFile" },
	config = function()
		require("conform").setup({
			-- Configure formatters here
			formatters_by_ft = {
				css = { "prettier" },
				graphql = { "prettier" },
				html = { "html" },
				javascript = { "prettier" },
				json = { "prettier" },
				lua = { "stylua" },
				javascript = { "prettierd", "prettier" },
				rust = { "rustfmt" },
				-- scala = { "scalafmt", lsp_fallback = true },
				typescript = { "prettier" },
				typescriptreact = { "prettier" },
				yaml = { "prettier" },
			},
			format_on_save = {
				lsp_fallback = true,
				async = false,
				timeout_ms = 10000,
			},
		})
	end,
}
