return {
	{
		"williamboman/mason.nvim",
		lazy = false,
		config = function()
			require("mason").setup()
		end,
	},
	{
		"williamboman/mason-lspconfig.nvim",
		lazy = false,
		opts = {
			ensure_installed = {
				"bashls",
				"biome",
				"bright_script",
				"cmake",
				"cssls",
				"diagnosticls",
				"dockerls",
				"gopls",
				"graphql",
				"html",
				"marksman",
				"jsonls",
				"lua_ls",
				"rust_analyzer",
				"taplo",
				"ts_ls",
				"yamlls",
			},
		},
		config = function()
			require("mason-lspconfig").setup({
				automatic_enable = {
					exclude = {
						-- "ts_ls",
						"vtsls",
					},
				},
			})
		end,
	},
	{
		"neovim/nvim-lspconfig",
		dependencies = {
			"b0o/schemastore.nvim",
		},
		event = { "BufReadPre", "BufNewFile" },
		config = function()
			vim.opt_local.omnifunc = "v:lua.vim.lsp.omnifunc"

			local disable_builtin_lsp_formatter = function(client)
				client.server_capabilities.document_formatting = false
				client.server_capabilities.document_range_formatting = false
			end

			local capabilities = require("cmp_nvim_lsp").default_capabilities()

			local ThePrimeagenGroup = vim.api.nvim_create_augroup("ThePrimeagen", {})

			vim.api.nvim_create_autocmd("LspAttach", {
				group = ThePrimeagenGroup,
				callback = function(e)
					local opts = { buffer = e.buf }
					vim.keymap.set("i", "<C-h>", function()
						vim.lsp.buf.signature_help()
					end, opts)
				end,
			})

			vim.lsp.config("dockerls", {})

			vim.lsp.config("cssls", { capabilities = capabilities })

			vim.lsp.config("ansiblels", {
				capabilities = capabilities,
				on_attach = disable_builtin_lsp_formatter,
			})

			vim.lsp.config("gopls", {
				capabilities = capabilities,
				on_attach = disable_builtin_lsp_formatter,
				cmd = { "gopls" },
				filetypes = { "go", "gomod", "gowork", "gotmpl" },
				project_root = { "go.work", "go.mod", ".git" },
			})

			vim.lsp.config("graphql", {
				capabilities = capabilities,
				on_attach = disable_builtin_lsp_formatter,
			})

			vim.lsp.config("jsonls", {
				capabilities = capabilities,
				on_attach = disable_builtin_lsp_formatter,
				settings = {
					json = {
						schemas = require("schemastore").json.schemas(),
						validate = { enable = true },
					},
				},
			})

			vim.lsp.config("marksman", {
				capabilities = capabilities,
				on_attach = disable_builtin_lsp_formatter,
			})

			vim.lsp.config("bright_script", {
				capabilities = capabilities,
				on_attach = disable_builtin_lsp_formatter,
				cmd = { "bsc", "--lsp", "--stdio" },
				filetypes = { "bs", "brs" },
				root_markers = { "bsconfig.json", "makefile", "Makefile", ".git" },
			})
			-- local swift_capabilities = require("cmp_nvim_lsp").default_capabilities()
			-- swift_capabilities.workspace.didChangeWatchedFiles = { dynamicRegistration = true }
			vim.lsp.config("sourcekit", {
				capabilities = capabilities,
			})

			vim.lsp.config("yamlls", {
				capabilities = capabilities,
				filetypes = { "yaml", "yml" },
				settings = {
					yaml = {
						completion = true,
						customTags = {
							"!And",
							"!If",
							"!Not",
							"!Equals",
							"!Equals sequence",
							"!Or",
							"!FindInMap sequence",
							"!Base64",
							"!Cidr",
							"!Ref",
							"!Sub",
							"!GetAtt",
							"!GetAZs",
							"!ImportValue",
							"!Select",
							"!Select sequence",
							"!Split",
							"!Join sequence",
						},
						format = {
							enable = true,
						},
						hover = true,
						validate = true,
					},
				},
			})
		end,
		keys = {
			{
				"gD",
				function()
					vim.lsp.buf.declaration()
				end,
				{ desc = "[G]o to [D]eclaration" },
			},
			{
				"gd",
				"<CMD>Telescope lsp_definitions<CR>",
				{ desc = "[G]o to [D]efnition" },
			},
			{
				"K",
				function()
					vim.lsp.buf.hover()
				end,
			},
			{
				"gi",
				function()
					vim.lsp.buf.implementation()
				end,
				{ desc = "List implementations in quickfix" },
			},
			{
				"gr",
				"<CMD>Telescope lsp_references<CR>",
				{ desc = "Find references in quickfix" },
			},
			{
				"gds",
				function()
					vim.lsp.buf.document_symbol()
				end,
			},
			{
				"gws",
				function()
					vim.lsp.buf.workspace_symbol()
				end,
			},
			{
				"<leader>D",
				function()
					vim.lsp.buf.type_definition()
				end,
			},
			{
				"<leader>rn",
				function()
					vim.lsp.buf.rename()
				end,
			},
			{
				"<C-k>",
				function()
					vim.lsp.buf.signature_help()
				end,
				mode = { "n", "i" },
				desc = "Signature help",
			},
			{
				"<leader>o",
				function()
					vim.lsp.buf.format({ async = true })
				end,
			},
			{
				"<leader>ca",
				function()
					vim.lsp.buf.code_action()
				end,
			},
			{
				"<leader>cl",
				function()
					vim.lsp.codelens.run()
				end,
			},
			{
				"<leader>th",
				function()
					vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({}))
				end,
				{ desc = "[T]oggle Inlay [H]ints" },
			},
		},
	},
}
